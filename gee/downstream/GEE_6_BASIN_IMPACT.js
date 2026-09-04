/**********************************************************************
 * GEE export 6: Tapajos downstream river-change analysis
 * --------------------------------------------------------------------
 * Required Geometry Import: impact_window (closed polygon).
 *
 * The script clips the level-4 Tapajos system to a pre-defined study
 * window, exports level-12 HydroBASINS topology, and samples annual
 * 64-dimensional AlphaEarth embeddings along permanent-water river
 * stations for 2019 and 2024. Station exports are split into five tasks
 * to remain below Earth Engine computed-value limits.
 *
 * Notebook 02 then summarises the AMW raster by basin, accumulates mining
 * area through NEXT_DOWN, and tests whether signed AlphaEarth change adds
 * out-of-catchment predictive information about upstream mining growth.
 * This is a predictive association analysis, not causal pollution evidence.
 * Optional NDTI exports remain available as a physical sensitivity check.
 **********************************************************************/

// #####################################################################
// ★★★★★  只改这一块  ★★★★★
// #####################################################################
// 这五行是每次导出唯一要动的东西。别的地方都不用找。
// ★ 年份。AlphaEarth 是逐年资产，改这一行就换年份导出。
//   站点几何完全不变（河网、间距、缓冲都与年份无关），JRC 水体掩膜也是静态的
//   GSW1_4 —— 所以两个年份采的是【同一批像元】，相减才有意义。
//   文件名里带年份，2019 和 2024 不会互相覆盖。
var YEAR = 2019;                     // Run once for 2019 and once for 2024.

var DO_EXPORT   = true;              // false = 只看诊断，不生成任务
var EXPORT_WHICH = 'alpha_station';  // 'basins' | 'alpha_station' | 'ndti_basin'
                                     //  | 'alpha'(旧,已炸) | 'ndti'(旧,贵) | 'mines'

// ★ 成本 = 站点数 × 130 EECU-秒（实测，见文件中部 v5 注释）。
//   STATION_TARGET_N 直接决定这次分析有多少个空间独立样本，也就直接决定账单：
//   400 站点 ≈ 52,000 EECU-秒 ≈ 14 小时；2,230 站点 ≈ 290,000 ≈ 80 小时。
var STATION_TARGET_N = 0;     // 用多少站点。0 = 全部（Tapajós 北部共 2,230 个）
var N_CHUNKS = 5;             // 切成几块导（每块一个任务）
var CHUNK_I  = 0;             // 只在 SUBMIT_ALL_CHUNKS=false 时有用
var SUBMIT_ALL_CHUNKS = true; // true = 按一次 Run 就把 N_CHUNKS 个任务全排上

// #####################################################################
// ⚙️  个人设置
// #####################################################################
// 1) 支流系统的种子点（决定完整的汇流拓扑范围）
var SEEDS = { TAPAJOS: {lon: -56.30, lat: -6.30} };

// 2) 用 HydroBASINS 哪一级界定系统。4 = 塔帕若斯全流域 494,533 km²，
//    UP/SUB = 1.00004，已验证是完整集水区。
var SYSTEM_LEVEL = 4;
var HYBAS_PREFIX = 'WWF/HydroSHEDS/v1/Basins/hybas_';

// 3) ★★ 影像采样窗口 —— 反应变量只在这里测。
//    在 Code Editor 里画一个覆盖目标北部矿区、并在南侧截断流域的 Polygon，
//    Import 名称必须改成 impact_window。最终研究区会自动 clip 到白色的
//    “种子支流系统”边界，不会使用窗口在流域外的部分。
//    没有这个 Import 时，脚本进入“仅预览边界”模式：只显示白色流域边界，
//    方便你照着画；只有尝试导出时才会阻止运行。
var HAS_IMPACT_WINDOW = (typeof impact_window !== 'undefined');
var STUDY_WINDOW = HAS_IMPACT_WINDOW ? ee.Geometry(impact_window) : null;
var USE_WINDOW = true;    // false = 种子点所在的完整四级流域（非常贵）

// 4) 河网撒点密度。
//    analysis 保留每 3 km 一个点，使多数 level-12 子流域有机会达到 3 个点；
//    pilot 只用于检查流程，不能作为论文最终的子流域均值。
var SAMPLING_MODE = 'analysis';       // 'analysis' | 'pilot'
var SPACING_M = SAMPLING_MODE === 'pilot' ? 8000 : 3000;   // 旧的铺开式，已弃用

// ★★★ 站点式采样 —— 这一组是成本的全部关键，先读完再跑
//
// 【实测的成本模型】失败那次：4,054,634 EECU-秒 ÷ 约 24,000 块瓦片
//   = 每块瓦片 169 EECU-秒。sampleRegions 按瓦片计费，一块瓦片永远是
//   256x256 像元 x 64 波段 = 420 万个值，不管你从里面取 1 个点还是 100 个。
//   点每 3 km 一个、而 scale 10 的瓦片只有 2.56 km 宽 → 几乎一点一瓦片，
//   420 万个值只用了 64 个。
//
// 【所以成本 = 瓦片数，与点数、与 AOI 面积基本无关】
//   训练集导出之所以便宜，正是因为每个多边形 200 个点全挤在一两块瓦片里。
//
// 【站点式】沿河网每 STATION_SPACING_M 设一个站点，每个站点在
//   STATION_LENGTH_M 的河段内密集取 POINTS_PER_STATION 个点，
//   这些点全落在同一块瓦片内 → 瓦片数 = 站点数。
var USE_STATIONS = true;
var STATION_SPACING_M   = 30000;   // 站点间距
var STATION_LENGTH_M    = 2000;    // 每个站点覆盖的河段长度
var POINTS_PER_STATION  = 20;      // 只在旧的 'alpha' 逐点模式下有用；
                                   // 'alpha_station' 直接对整段河求均值，与它无关
var STATION_RIV_ORD_MAX = 5;       // 站点只设在这个等级以内的河上
// ★ STATION_LIMIT 的外推已被实测证伪，见下方 v5 注释。设 0 = 不限。
var STATION_LIMIT = 0;

// =====================================================================
// ★★★ v5 —— 实测重新标定的成本模型，以及 "too large" 的修法
// =====================================================================
// 实测三个点：
//   10 站点（STATION_LIMIT=10）          =         4.58 EECU-秒  成功
//   2,230 站点 × 20 点 = 44,600 点        =   563,967 EECU-秒  失败 (too large)
//   旧铺开式 420 万点                     = 4,054,634 EECU-秒  失败
//
// 从 10 站点线性外推得到 1,021 EECU-秒，实际是 563,967 —— 差 550 倍。
// 原因：那 10 个站点是服务器顺序里的头 10 个，全挤在同一条河的同一片瓦片里，
// 几乎没有付瓦片钱。站点一旦按 30 km 铺开，每个站点就独占一块瓦片。
//
// 【第四个实测点，station_mean 模式】
//   189 站点（全窗口随机抽） = 24,565.55 EECU-秒，4 分钟，成功。
//   → 130.0 EECU-秒/站点。这次的外推可信：这 189 个彼此不共用瓦片，
//     已经处在「每站点一块瓦片」的最贵状态，没有上次那个共用瓦片的陷阱。
//
// 【标定后的模型】 成本 ≈ 站点数 × 130 EECU-秒   (scale 10, 64 波段, station_mean)
//   因为 scale 10 的一块瓦片只有 2.56 km 宽，而站点间距 30 km，
//   所以站点之间永远不共享瓦片 —— 站点数就是瓦片数，一个都省不掉。
//   推论：有效样本量 ≈ 成本 / 130。想要 N 个独立站点，就得付 N×130 EECU-秒。
//   改 scale、改每站点点数、改缓冲半径都绕不过去 —— 一块瓦片永远是
//   256x256x波段数，跟你从里面取多少像元无关。所以放大 STATION_BUFFER_M
//   是免费的（同一块瓦片内），加站点是要钱的。
//
// 【"Computed value is too large" 是另一回事】—— 那是输出体积，不是成本。
//   44,600 行 × 67 列要在一个 computed value 里物化，超上限。
//   修法：不要逐点导出。ASGM_04 现在本来就是把每个站点的 20 个点求均值，
//   所以直接在 GEE 端用 reduceRegions 对整段站点河段求均值，
//   输出 1 行/站点而不是 20 行/站点，体积降 20 倍，结果完全等价。
//
// 【分块导出】 把站点切成 N_CHUNKS 块，每块一个任务。
//   SUBMIT_ALL_CHUNKS=true 时一次 Run 把所有块排上队，GEE 会顺序跑；
//   false 时只导 CHUNK_I 那一块（想先试成本时用）。分块的意义是：
//   任何一块失败或超时，只损失那一块，前面已完成的 CSV 都还在 Drive 里。
var ALPHA_MODE = 'station_mean';   // 'station_mean'(推荐) | 'points'(旧，炸过两次)
// 150 m：Tapajós 干流有些宽度超过 200 m，60 m 走廊只采到河心。150 m 仍远在
// 2.56 km 的瓦片内 —— 不增加瓦片数就等于不增加成本，但每站点的水体像元数
// 明显变多，均值更稳。窄河那边会纳入部分河漫滩常年水体，§7.5.2 需声明。
// ★ 改了这个数就必须重跑所有分块：60 m 和 150 m 的均值不可混用。
//   文件名里带 _b<数值>，ASGM_04 会拒绝把两种混在一起。
var STATION_BUFFER_M  = 150;      // 站点河段向两侧缓冲
var ALPHA_WATER_MASK  = true;      // A 波段只在 JRC 常年水体像元上求均值
var INCLUDE_UNMASKED  = false;     // 额外导出未掩膜的 B00..B63（成本翻倍）
// ★ STATION_TARGET_N / N_CHUNKS / CHUNK_I 已移到文件最顶上的「只改这一块」。
var RIV_ORD_MAX = SAMPLING_MODE === 'pilot' ? 6 : 7;

// 5) NDTI 数据源与影像窗口。
//    Landsat 8/9 是原生 30 m，和最终 NDTI 尺度一致，读取量明显低于先算
//    10 m Sentinel-2 再降到 30 m。需要做小范围敏感性检查时可切回 sentinel2。
//    两者不能混在同一次正式分析中。
var NDTI_SOURCE = 'landsat30';        // 'landsat30' | 'sentinel2'
var NDTI_START = '-07-01';
var NDTI_END   = '-08-15';
var NDTI_MAX_CLOUD = 40;

// 6) 采样尺度。AlphaEarth 必须原生 10 m；NDTI 用 30 m 省 9 倍，
//    RIV_ORD<=7 的河基本都宽于 30 m。
var SCALE_ALPHA = 10;
var SCALE_NDTI  = 30;

// 7) ★ 一次只导一个任务，跑完看 EECU-秒再导下一个：
//    ★ EXPORT_WHICH 已移到文件最顶上的「只改这一块」。

// 8) 点抽稀只用于快速检查表结构，不能用于外推完整任务 EECU。
//    原因是随机 5% 的点仍散布在整个窗口，可能触发几乎相同数量的 S2 瓦片。
//    正式导出保持 1.0；需要成本试跑时，另画一个闭合 impact_pilot_window。
var TEST_FRACTION = 1.0;
var USE_PILOT_WINDOW = false;
var HAS_PILOT_WINDOW = (typeof impact_pilot_window !== 'undefined');

// 9) ★ 只在地图上显示 AMW 矿痕（纯预览，不参与任何导出、不产生批处理任务）
//    剂量仍然在 Colab 里用 data/amw_scar2024.tif 算，GEE 不读这个栅格做统计。
var SHOW_AMW = true;
var AMW_ASSET_TIF = 'projects/zcfaew0/assets/amw_scar2024_tif';
var MIN_PERIOD = 2018;
var MAX_PERIOD = 2024;

// 9b) 可选：打印窗口内的矿区面积。★ 这一条会真的读栅格、产生计算，
//     平时保持 false；想要那个数字时再单独打开一次。
var PRINT_MINE_AREA = false;

// 10) 导出开关
// DO_EXPORT 已移到文件最顶上的「只改这一块」。
// #####################################################################


// YEAR 已移到文件最顶上的「只改这一块」。
var DETHIER_ASSET = 'projects/zcfaew0/assets/asgm_global_sites';
var HYBAS12 = 'WWF/HydroSHEDS/v1/Basins/hybas_12';
var WINDOW_TAG = HAS_IMPACT_WINDOW ? 'CUSTOM' : 'PREVIEW';
var TAG = Object.keys(SEEDS).join('-') + '_' + WINDOW_TAG;


// =====================================================================
// 1. 完整拓扑范围与影像采样窗口
// =====================================================================
var seedPts = ee.FeatureCollection(Object.keys(SEEDS).map(function(k) {
  return ee.Feature(ee.Geometry.Point([SEEDS[k].lon, SEEDS[k].lat]), {seed: k});
}));
var hybasSystems = ee.FeatureCollection(HYBAS_PREFIX + SYSTEM_LEVEL);
var seedSystems = hybasSystems.filterBounds(seedPts);
var seedSystemGeom = seedSystems.geometry(1000);

// 没有 impact_window 时，只在种子点周围放一个 1 km 的临时计算区，避免为了
// 看白色边界而触发全流域影像计算。这个临时区不会被允许导出。
var PREVIEW_ONLY = USE_WINDOW && !HAS_IMPACT_WINDOW;
if (DO_EXPORT && PREVIEW_ONLY) {
  throw new Error(
    '当前只有白色边界预览，不能导出。请画闭合 Polygon 并命名为 impact_window。');
}

// ★ 正确关系：最终采样区 = 外部窗口 ∩ 种子支流系统。
// 外部窗口负责纳入北部矿区并在南侧截断；seedSystemGeom 负责让左右边界
// 严格沿支流系统边界走。因此既不铺满矩形，也不采完整 49 万 km² 流域。
var requestedSampleGeom = PREVIEW_ONLY
  ? seedPts.geometry().buffer(1000)
  : (USE_WINDOW
      ? ee.Geometry(seedSystemGeom.intersection(STUDY_WINDOW, 1000))
      : seedSystemGeom);
var sampleGeom = (USE_PILOT_WINDOW && HAS_PILOT_WINDOW)
  ? ee.Geometry(requestedSampleGeom.intersection(impact_pilot_window, 1000))
  : requestedSampleGeom;

// 完整 seed system 只用于 HYBAS_ID / NEXT_DOWN 拓扑和上游剂量累加；
// AlphaEarth 与 NDTI 始终只读取上面的 sampleGeom。
var systems = seedSystems;
var sysGeom = seedSystemGeom;

// 相关系统的全部 level-12 子流域 —— NEXT_DOWN 累加需要完整拓扑，不能裁。
var b12all = ee.FeatureCollection(HYBAS12).filterBounds(sysGeom);


// =====================================================================
// 2. 采样栈（★ 没有任何 reduceToImage —— 流域号在 Colab 里用点面叠加得到）
// =====================================================================
// Sentinel-2 只留下红、绿波段，并屏蔽云、阴影、雪和坏像元。
function maskS2sr(img) {
  var scl = img.select('SCL');
  var bad = scl.eq(1).or(scl.eq(3)).or(scl.eq(8)).or(scl.eq(9))
              .or(scl.eq(10)).or(scl.eq(11));
  return img.updateMask(bad.not())
    .select(['B4', 'B3'], ['red', 'green']).divide(10000);
}

// Landsat Collection 2 Level 2：QA_PIXEL 位屏蔽填充值、膨胀云、卷云、云、
// 云影和雪；QA_RADSAT 屏蔽饱和像元。反射率按官方 scale/offset 还原。
function maskLandsatL2(img) {
  var qa = img.select('QA_PIXEL');
  var clear = qa.bitwiseAnd(1 << 0).eq(0)
    .and(qa.bitwiseAnd(1 << 1).eq(0))
    .and(qa.bitwiseAnd(1 << 2).eq(0))
    .and(qa.bitwiseAnd(1 << 3).eq(0))
    .and(qa.bitwiseAnd(1 << 4).eq(0))
    .and(qa.bitwiseAnd(1 << 5).eq(0));
  var unsaturated = img.select('QA_RADSAT').eq(0);
  return img.updateMask(clear).updateMask(unsaturated)
    .select(['SR_B4', 'SR_B3'], ['red', 'green'])
    .multiply(0.0000275).add(-0.2);
}

// 根据开关构建统一命名为 red/green 的集合；正式运行时只会走其中一条。
function loadNdtiCollection(startDate, endDate) {
  if (NDTI_SOURCE === 'sentinel2') {
    return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterDate(startDate, endDate)
      .filterBounds(sampleGeom)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', NDTI_MAX_CLOUD))
      .map(maskS2sr);
  }
  var l8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2');
  var l9 = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2');
  return l8.merge(l9)
    .filterDate(startDate, endDate)
    .filterBounds(sampleGeom)
    .filter(ee.Filter.lt('CLOUD_COVER', NDTI_MAX_CLOUD))
    .map(maskLandsatL2);
}

var ndtiCol = loadNdtiCollection(YEAR + NDTI_START, YEAR + NDTI_END);
// ★★ median 换成【单景 mosaic】。median 要求每个输出像元把 N 景全读进来再排序；
//    按云量降序排列后 mosaic，云量最低的那一景压在最上面，每个位置只读 1-2 景。
//    旱季单次晴空影像本来就是浊度研究的常规做法，方法上不是妥协。
var NDTI_CLOUD_PROP = (NDTI_SOURCE === 'sentinel2')
  ? 'CLOUDY_PIXEL_PERCENTAGE' : 'CLOUD_COVER';
var ndtiReflectance = ndtiCol.sort(NDTI_CLOUD_PROP, false).mosaic();
var ndti = ndtiReflectance.expression(
  '(red - green) / (red + green)', {
    red: ndtiReflectance.select('red'),
    green: ndtiReflectance.select('green')
  }).rename('NDTI');

var alpha = ee.ImageCollection('GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL')
  .filterDate(YEAR + '-01-01', (YEAR + 1) + '-01-01')
  .filterBounds(sampleGeom).mosaic();
var newNames = ee.List.sequence(0, 63).map(function(i) {
  return ee.String('A').cat(ee.String(ee.Number(i).int().format('%02d')));
});
alpha = alpha.select(alpha.bandNames(), newNames);

// ★ 不做水体掩膜：非常年水面的点正是"NDTI 用不了、嵌入还能用"那条论证
//   要用的样本。掩膜留到 Colab，用 jrc_occurrence 一列切分。
var jrc = ee.Image('JRC/GSW1_4/GlobalSurfaceWater')
  .select('occurrence').unmask(0).rename('jrc_occurrence');
var dem = ee.Image('USGS/SRTMGL1_003').rename('elev');
var acc = ee.Image('WWF/HydroSHEDS/15ACC').rename('flow_acc');

var stackAlpha = alpha.addBands(jrc).addBands(dem).addBands(acc);


// =====================================================================
// 2b. ★★ NDTI 按【子流域】归约，不再逐点采样 —— 这是省钱的关键
// =====================================================================
// 实测：ndti_landsat30 的点采样烧了 755,071 EECU-秒后被取消；
// 同一批点上采 AlphaEarth 却很便宜。区别在于 AlphaEarth 是【已存储资产】，
// 读它是直接读瓦片；NDTI 是【现算的合成影像】，每碰一个瓦片就要把 N 景
// 连同 QA 波段全读进来、掩膜、归约。
//
// 而 sampleRegions 是按瓦片物化的：N 个散点 ≈ N 个 256x256 瓦片被算出来，
// 每个瓦片 65,536 个像元里只用 1 个，浪费 99.998%。
//
// 本分析的单元本来就是子流域，从来不需要逐点 NDTI。改成 reduceRegions：
// 整个研究区只算一遍，直接得到每个子流域的水面平均 NDTI。
var WATER_OCC_MIN = 30;          // JRC 常年水体占比阈值
var b12aoi = b12all.filterBounds(sampleGeom);
var ndtiWater = ndti.updateMask(jrc.gte(WATER_OCC_MIN));

var ndtiByBasin = ndtiWater.addBands(ee.Image.pixelArea().rename('water_m2'))
  .reduceRegions({
    collection: b12aoi.select(['HYBAS_ID','NEXT_DOWN','SUB_AREA','UP_AREA','PFAF_ID']),
    reducer: ee.Reducer.mean().setOutputs(['ndti_mean'])
               .combine({reducer2: ee.Reducer.count().setOutputs(['n_water_px']),
                         sharedInputs: false}),
    scale: SCALE_NDTI, tileScale: 16
  });


// =====================================================================
// 3. 河网撒点
// =====================================================================
var rivers = ee.FeatureCollection('WWF/HydroSHEDS/v1/FreeFlowingRivers')
  .filterBounds(sampleGeom)
  .filter(ee.Filter.lte('RIV_ORD', RIV_ORD_MAX));

// ---- 站点式：先把河切成 STATION_SPACING_M 的段，每段起点算一个站点，
//      再在站点所在的 STATION_LENGTH_M 河段内密集取点。
//      所有点落在同一块瓦片内，瓦片数 = 站点数。
var stationRivers = rivers.filter(ee.Filter.lte('RIV_ORD', STATION_RIV_ORD_MAX));

var stationReaches = ee.FeatureCollection(stationRivers.map(function(r) {
  var g = r.geometry();
  var len = g.length(100);
  // 按站点间距切开，每一段的【前 STATION_LENGTH_M】就是一个站点河段
  var cuts = ee.List.sequence(STATION_SPACING_M, len, STATION_SPACING_M);
  var segs = ee.Geometry(g.cutLines(cuts, 100)).geometries();
  segs = segs.slice(0, ee.Number(segs.size()).min(40));
  var rid = ee.String(r.get('system:index'));
  return ee.FeatureCollection(
    ee.List.sequence(0, ee.Number(segs.size()).subtract(1)).map(function(k) {
      k = ee.Number(k);
      var seg = ee.Geometry(segs.get(k));
      var sl = seg.length(50);
      // 只保留够长的段，太短的说明是切剩下的尾巴
      var head = ee.Geometry(ee.Algorithms.If(
        sl.gt(STATION_LENGTH_M),
        ee.Geometry(seg.cutLines([STATION_LENGTH_M], 50)).geometries().get(0),
        seg));
      return ee.Feature(head, {
        station_id: rid.cat('_s').cat(k.format('%d')),
        riv_ord: r.get('RIV_ORD'), reach_len_m: sl});
    }));
}).flatten()).filter(ee.Filter.gte('reach_len_m', STATION_LENGTH_M * 0.8))
  .filterBounds(sampleGeom);

if (STATION_LIMIT > 0) {
  stationReaches = stationReaches.limit(STATION_LIMIT);
}

// 在每个站点河段内密集取点
var ptsStations = ee.FeatureCollection(stationReaches.map(function(f) {
  var g = f.geometry();
  var len = g.length(50);
  var step = len.divide(POINTS_PER_STATION);
  var cuts = ee.List.sequence(step, len, step);
  var pieces = ee.Geometry(g.cutLines(cuts, 50)).geometries();
  pieces = pieces.slice(0, ee.Number(pieces.size()).min(POINTS_PER_STATION));
  var sid = ee.String(f.get('station_id'));
  return ee.FeatureCollection(
    ee.List.sequence(0, ee.Number(pieces.size()).subtract(1)).map(function(k) {
      k = ee.Number(k);
      return ee.Feature(ee.Geometry(pieces.get(k)).centroid(50), {
        station_id: sid, riv_ord: f.get('riv_ord'),
        pid: sid.cat('_p').cat(k.format('%d'))});
    }));
}).flatten());

// =====================================================================
// 3b. ★★ 站点均值直采 —— 1 行/站点，替代 20 行/站点的逐点导出
// =====================================================================
// 分块：用固定种子的随机列切成 N_CHUNKS 块。块与块之间在空间上是交错的，
// 所以任何一块单独拿出来都是整个研究区的一个无偏子样本 —— 万一只导得起
// 一两块，得到的仍然是可用的分析样本，而不是研究区的一个角。
// 先从全部站点里随机抽 STATION_TARGET_N 个 —— 随机抽样保留了空间铺开程度
// 和沿汇流距离的分布，只是把样本量（也就是账单）降到能付得起的水平。
// 种子固定，所以每一块导出用的都是同一个 400 站点池子，块与块不重叠。
var stationPool = (STATION_TARGET_N > 0)
  ? stationReaches.randomColumn('_c', 42).limit(STATION_TARGET_N, '_c')
  : stationReaches;

function stationChunkAt(i) {
  if (N_CHUNKS <= 1) { return stationPool; }
  return stationPool.randomColumn('_k', 7).filter(ee.Filter.and(
    ee.Filter.gte('_k', i / N_CHUNKS),
    ee.Filter.lt('_k', (i + 1) / N_CHUNKS)));
}
var stationChunk = stationChunkAt(CHUNK_I);   // 只用于下面的诊断打印

// A 波段：按需水体掩膜；jrc_occ / water_frac 不掩膜，用来判断这个站点
// 到底有多少常年水面，Colab 的 water-only 子集就靠 water_frac 划。
var alphaMasked = ALPHA_WATER_MASK
  ? alpha.updateMask(jrc.gte(WATER_OCC_MIN)) : alpha;
var alphaStack = alphaMasked
  .addBands(jrc.rename('jrc_occ').unmask(0))
  .addBands(jrc.gte(WATER_OCC_MIN).rename('water_frac').unmask(0));
if (INCLUDE_UNMASKED) {
  var Bn = [];
  for (var bi = 0; bi < 64; bi++) { Bn.push('B' + (bi < 10 ? '0' + bi : '' + bi)); }
  alphaStack = alphaStack.addBands(alpha.rename(Bn));
}

function alphaByStationAt(i) {
  return alphaStack.reduceRegions({
    collection: stationChunkAt(i).map(function(f) {
      return f.setGeometry(f.geometry().buffer(STATION_BUFFER_M, 10));
    }),
    reducer: ee.Reducer.mean(),
    scale: SCALE_ALPHA, tileScale: 16
  }).map(function(f) {
    var c = f.geometry().centroid(50).coordinates();
    return f.set({lon: c.get(0), lat: c.get(1), n_points: 1}).setGeometry(null);
  });
}


// ---- 旧的铺开式采样，保留但默认不用（它就是烧掉 400 万 EECU-秒的那个）----
var ptsSpread = ee.FeatureCollection(rivers.map(function(r) {
  var g = r.geometry();
  var len = g.length(100);
  var cuts = ee.List.sequence(SPACING_M, len, SPACING_M);
  var pieces = ee.Geometry(g.cutLines(cuts, 100)).geometries();
  pieces = pieces.slice(0, ee.Number(pieces.size()).min(300));
  var rid = ee.String(r.get('system:index'));
  return ee.FeatureCollection(
    ee.List.sequence(0, ee.Number(pieces.size()).subtract(1)).map(function(k) {
      k = ee.Number(k);
      return ee.Feature(ee.Geometry(pieces.get(k)).centroid(100), {
        riv_ord: r.get('RIV_ORD'), riv_id: r.get('RIV_ID'),
        station_id: 'spread',
        pid: rid.cat('_').cat(k.format('%d'))});
    }));
}).flatten()).filterBounds(sampleGeom);

var pts = USE_STATIONS ? ptsStations : ptsSpread;

if (TEST_FRACTION < 1.0) {
  pts = pts.randomColumn('_r', 42).filter(ee.Filter.lt('_r', TEST_FRACTION));
}

function withLonLat(fc) {
  return fc.map(function(f) {
    var c = f.geometry().coordinates();
    return f.set({lon: c.get(0), lat: c.get(1)}).setGeometry(null);
  });
}
var sampleAlpha = withLonLat(stackAlpha.sampleRegions({
  collection: pts, properties: ['pid', 'station_id', 'riv_ord'],
  scale: SCALE_ALPHA, tileScale: 16, geometries: true}));
var sampleNdti = withLonLat(ndti.sampleRegions({
  collection: pts, properties: ['pid'],
  scale: SCALE_NDTI, tileScale: 16, geometries: true}));


// =====================================================================
// 4. 地图
// =====================================================================
var s0 = SEEDS[Object.keys(SEEDS)[0]];
Map.centerObject(PREVIEW_ONLY ? seedSystemGeom : sampleGeom,
                 PREVIEW_ONLY ? 6 : 7);
Map.setOptions('SATELLITE');
Map.addLayer(seedSystems.style({color:'ffffff', fillColor:'00000000', width:2}),
             {}, '种子支流系统（完整拓扑）', true);
if (HAS_IMPACT_WINDOW) {
  Map.addLayer(ee.FeatureCollection([ee.Feature(STUDY_WINDOW)])
               .style({color:'ffea00', fillColor:'00000000', width:1}),
               {}, '外部截断窗口（impact_window）', false);
  Map.addLayer(ee.FeatureCollection([ee.Feature(sampleGeom)])
               .style({color:'ffb74d', fillColor:'00000000', width:3}),
               {}, '★ 最终采样区（窗口 clip 到种子支流边界）', true);
}
Map.addLayer(rivers.style({color:'2979ff', width:1}), {}, '河网（窗口内）', !PREVIEW_ONLY);
Map.addLayer(ndti.updateMask(jrc.gte(30)), {min:-0.3, max:0.3,
  palette:['0571b0','92c5de','f7f7f7','f4a582','ca0020']}, 'NDTI（仅水面）', false);
Map.addLayer(seedPts, {color:'ff3d00'}, '种子点', true);

// ---- AMW 矿痕（预览）------------------------------------------------------
// ★ 这个栅格的值是【时期代码】（2018…2025、20251…20262），不是 0/1，
//   而 GEE 的金字塔按平均建，所以缩小看的时候 0 和 2024 会被平均成
//   1012 这类中间值。因此给两个图层：
//     A「任意时期」用 gt(0) —— 平均之后只要非零就还是非零，缩放到哪一级
//       都能正确显示"这里有没有矿"，适合缩小了找位置。
//     B「2018-2024」是精确的时期掩膜 —— 只在放大到接近 10 m 时才准，
//       缩小看会漏掉一些，那是金字塔造成的，不是数据问题。
if (SHOW_AMW) {
  var amwRaw = ee.Image(AMW_ASSET_TIF).select(0).unmask(0);
  var amwAny = amwRaw.gt(0).selfMask();
  var amwPeriod = amwRaw.gte(MIN_PERIOD).and(amwRaw.lte(MAX_PERIOD))
                        .setDefaultProjection(amwRaw.projection()).selfMask();

  Map.addLayer(amwAny, {palette: ['ff3d00']},
               'AMW 矿痕 · 任意时期（缩小看用这个）', true);
  Map.addLayer(amwPeriod, {palette: ['ffea00']},
               'AMW 矿痕 · ' + MIN_PERIOD + '-' + MAX_PERIOD + '（放大看才准）', false);
  // 年份着色：看采矿是怎么扩张的，找窗口边界时很有用
  Map.addLayer(amwRaw.updateMask(amwRaw.gte(MIN_PERIOD).and(amwRaw.lte(MAX_PERIOD))),
               {min: MIN_PERIOD, max: MAX_PERIOD,
                palette: ['2c7bb6','abd9e9','ffffbf','fdae61','d7191c']},
               'AMW 首次检出年份（蓝=早 红=晚）', false);
}

// 采样点本身也画出来，看窗口有没有漏掉主干河道
Map.addLayer(pts.style({color: '00e5ff', pointSize: 2}),
             {}, '采样点（当前设置）', false);


// =====================================================================
// 5. 诊断
// =====================================================================
print('=== GEE 脚本 6 v4：流域尺度影响分析 ===  系统:', TAG);
print('--- 范围 ---');
print('使用了自定义 impact_window:', HAS_IMPACT_WINDOW);
if (PREVIEW_ONLY) {
  print('★★ 当前是边界预览模式：白线已显示；请据此画 Polygon，命名为 impact_window。');
  print('★★ 预览模式不会允许导出，也不会采样完整流域。');
}
print('采样窗口几何类型（必须是 Polygon/MultiPolygon）:', sampleGeom.type());
print('种子四级流域数:', seedSystems.size());
print('完整种子系统面积合计 (km²；不会全部读取影像):',
      systems.aggregate_sum('SUB_AREA'));
print('★ 采样窗口面积 (km²):', sampleGeom.area(1000).divide(1e6));
print('  只有这个窗口会读取 NDTI 和 AlphaEarth；拓扑系统面积不等于采样面积。');
print('全系统 level-12 子流域数（拓扑用，不裁）:', b12all.size());

print('--- 采样规模 ---');
print('河段数 (RIV_ORD <= ' + RIV_ORD_MAX + '，窗口内):', rivers.size());
print('河网总长 (km):', rivers.geometry(1000).length(1000).divide(1000));
print('--- ★ 站点式采样（成本 = 瓦片数 ≈ 站点数）---');
print('USE_STATIONS:', USE_STATIONS, ' STATION_LIMIT:', STATION_LIMIT);
print('站点数:', stationReaches.size());
print('每站点取点数:', POINTS_PER_STATION, ' 站点河段长 (m):', STATION_LENGTH_M);
print('本次总采样点数:', pts.size());
print('--- ★ v5 成本（已用 2,230 站点的失败任务重新标定）---');
print('ALPHA_MODE:', ALPHA_MODE, ' 水体掩膜:', ALPHA_WATER_MASK,
      ' 含未掩膜 B 波段:', INCLUDE_UNMASKED);
print('全部可用站点数:', stationReaches.size());
print('★ 实际使用的站点池 (STATION_TARGET_N=' + STATION_TARGET_N +
      '，0=全部):', stationPool.size());
print('河道走廊半宽 STATION_BUFFER_M (m):', STATION_BUFFER_M);
print('分块: 共', N_CHUNKS, '块；SUBMIT_ALL_CHUNKS =', SUBMIT_ALL_CHUNKS);
print('★ 单块站点数（= 单块瓦片数 = 单块成本主项）:', stationChunk.size());
print('★ 标定后单价：130 EECU-秒/站点 (scale 10, 64 波段, station_mean)。');
print('   实测：189 站点 = 24,565.55 EECU-秒 → 24565.55/189 = 130.0，4 分钟完成。');
print('   这 189 个是全窗口随机抽的、彼此不共用瓦片，所以线性外推这次可信。');
print('   对照：同样 2,230 站点，旧的逐点法烧了 563,967 还失败了。');
print('★ 单块预估 EECU-秒:',
      stationChunk.size().multiply(INCLUDE_UNMASKED ? 260 : 130));
print('★ 全部 ' + N_CHUNKS + ' 块跑完的预估总额 EECU-秒:',
      stationPool.size().multiply(INCLUDE_UNMASKED ? 260 : 130));
print('★ 以 Tasks 面板实测为准。');
print('采样模式:', SAMPLING_MODE, ' 旧铺开式点间距 (m):', SPACING_M);
print('本次实际采样点数:', pts.size());

print('--- 成本关键 ---');
// ★ 集合总数会随窗口面积增长，不是成本指标。真正决定成本的是
//   【每个位置上叠了多少景】—— 即 median 在单个像元上要读几张图。
var probePt = ee.Geometry.Point([s0.lon, s0.lat]);
print('NDTI 数据源:', NDTI_SOURCE);
print('NDTI 集合总影像数（会随窗口面积涨，不是成本指标）:', ndtiCol.size());
print('★ 每个位置叠的影像数（这才是成本主项）:',
      ndtiCol.filterBounds(probePt).size());
print('  Landsat 8/9 六周通常比 Sentinel-2 10 m 合成便宜；实际以 Tasks EECU 为准。');
print('  这个数偏大就把 NDTI_END 往前收，或把 NDTI_MAX_CLOUD 调低。');
print('全年同一位置的影像数（对照）:',
      loadNdtiCollection(YEAR + '-01-01', (YEAR + 1) + '-01-01')
        .filterBounds(probePt).size());
print('NDTI 窗口:', YEAR + NDTI_START, '→', YEAR + NDTI_END,
      ' 云量上限:', NDTI_MAX_CLOUD);
print('采样尺度 AlphaEarth:', SCALE_ALPHA, ' NDTI:', SCALE_NDTI);
print('研究区内 level-12 子流域数（NDTI 按这个归约）:', b12aoi.size());
print('NDTI 合成方式: 单景 mosaic（按 ' +
      ((typeof NDTI_SOURCE !== 'undefined' && NDTI_SOURCE === 'sentinel2')
        ? 'CLOUDY_PIXEL_PERCENTAGE' : 'CLOUD_COVER') + ' 降序）');
print('★ EXPORT_WHICH 用 ndti_basin 代替 ndti —— 前者按流域归约，后者逐点采样');
print('EXPORT_WHICH:', EXPORT_WHICH, '   ★ YEAR:', YEAR);
print('★ DiD 提醒：站点几何和 JRC 掩膜都与年份无关，所以 2019 和 2024');
print('  采的是同一批水体像元，逐站点相减得到的就是同一段河的年际变化。');

if (SHOW_AMW && PRINT_MINE_AREA) {
  var mm = ee.Image(AMW_ASSET_TIF).select(0).unmask(0);
  var mask = mm.gte(MIN_PERIOD).and(mm.lte(MAX_PERIOD))
               .setDefaultProjection(mm.projection());
  var frac = mask.reduceResolution({reducer: ee.Reducer.mean(), maxPixels: 1024})
                 .reproject({crs: mm.projection().atScale(100)});
  print('窗口内 AMW 矿区面积 (km²):',
        frac.multiply(ee.Image.pixelArea()).reduceRegion({
          reducer: ee.Reducer.sum(), geometry: sampleGeom,
          scale: 100, maxPixels: 1e10, bestEffort: true})
          .getNumber('constant').divide(1e6));
  print('★ 这一条读了栅格、有计算成本，看完把 PRINT_MINE_AREA 改回 false');
}


// =====================================================================
// 6. 导出 —— 一次一个
// =====================================================================
if (DO_EXPORT) {
  var A = [];
  for (var i = 0; i < 64; i++) { A.push('A' + (i < 10 ? '0' + i : '' + i)); }
  var sfx = (TEST_FRACTION < 1.0) ? '_TEST' : '';

  // 流域多边形（带几何）—— 纯矢量导出，几乎不花钱。
  // Colab 用它做点面叠加拿 HYBAS_ID，也用它和 AMW geojson 做叠加拿剂量。
  if (EXPORT_WHICH === 'basins') {
    Export.table.toDrive({
      collection: b12all.select(['HYBAS_ID','NEXT_DOWN','MAIN_BAS','PFAF_ID',
                                 'SUB_AREA','UP_AREA','ENDO','COAST']),
      description: 'sa9_v8_basins_' + TAG,
      fileNamePrefix: 'sa9_v8_basins_' + TAG,
      fileFormat: 'GeoJSON'
    });
  }

  // ★ 推荐用这个代替 'ndti'：按流域归约，成本低一到两个数量级
  if (EXPORT_WHICH === 'ndti_basin') {
    Export.table.toDrive({
      collection: ndtiByBasin,
      description: 'sa9_v8_basin_ndti_byBasin_' + YEAR + '_' + TAG,
      fileNamePrefix: 'sa9_v8_basin_ndti_byBasin_' + YEAR + '_' + TAG,
      fileFormat: 'CSV',
      selectors: ['HYBAS_ID','NEXT_DOWN','SUB_AREA','UP_AREA','PFAF_ID',
                  'ndti_mean','n_water_px']
    });
  }

  if (EXPORT_WHICH === 'ndti') {
    Export.table.toDrive({
      collection: sampleNdti,
      description: 'sa9_v8_basin_ndti_' + NDTI_SOURCE + '_' + YEAR + '_' + TAG + sfx,
      fileNamePrefix: 'sa9_v8_basin_ndti_' + NDTI_SOURCE + '_' + YEAR + '_' + TAG + sfx,
      fileFormat: 'CSV', selectors: ['pid','lon','lat','NDTI']
    });
  }

  // ★★ 推荐：站点均值，1 行/站点，分块导出
  if (EXPORT_WHICH === 'alpha_station') {
    var selA = ['station_id','riv_ord','reach_len_m','lon','lat','n_points',
                'jrc_occ','water_frac'].concat(A);
    if (INCLUDE_UNMASKED) {
      for (var bj = 0; bj < 64; bj++) {
        selA.push('B' + (bj < 10 ? '0' + bj : '' + bj));
      }
    }
    // 文件名带上缓冲半径：60 m 和 150 m 的站点均值不是同一个量，
    // 混在同一个文件夹里会被 ASGM_04 当成重复站点悄悄合并。带上就不会。
    var base = 'sa9_v8_basin_alphaSt_' + YEAR + '_' + TAG +
               '_b' + STATION_BUFFER_M;
    var lo = SUBMIT_ALL_CHUNKS ? 0 : CHUNK_I;
    var hi = SUBMIT_ALL_CHUNKS ? (N_CHUNKS - 1) : CHUNK_I;
    for (var ci = lo; ci <= hi; ci++) {
      var nm = base + ((N_CHUNKS > 1) ? ('_c' + ci + 'of' + N_CHUNKS) : '');
      Export.table.toDrive({
        collection: alphaByStationAt(ci),
        description: nm, fileNamePrefix: nm,
        fileFormat: 'CSV', selectors: selA
      });
    }
    print('★ 已排队 ' + (hi - lo + 1) + ' 个 alpha_station 任务，前缀 ' + base);
  }

  if (EXPORT_WHICH === 'alpha') {
    Export.table.toDrive({
      collection: sampleAlpha,
      description: 'sa9_v8_basin_alpha_' + YEAR + '_' + TAG + sfx,
      fileNamePrefix: 'sa9_v8_basin_alpha_' + YEAR + '_' + TAG + sfx,
      fileFormat: 'CSV',
      selectors: ['pid','lon','lat','station_id','riv_ord',
                  'station_id','jrc_occurrence','elev','flow_acc'].concat(A)
    });
  }

  // Dethier 站点 —— 只导坐标，不采任何栅格（上一版就是栽在这里）
  if (EXPORT_WHICH === 'mines') {
    Export.table.toDrive({
      collection: withLonLat(ee.FeatureCollection(DETHIER_ASSET)
        .filterBounds(sysGeom)
        .map(function(f) {
          return ee.Feature(f.geometry().centroid(50), {
            mine_id: ee.String('dethier_').cat(ee.String(f.get('system:index')))});
        })),
      description: 'sa9_v8_basin_mines_dethier_' + TAG,
      fileNamePrefix: 'sa9_v8_basin_mines_dethier_' + TAG,
      fileFormat: 'CSV', selectors: ['mine_id','lon','lat']
    });
  }

  print('已生成导出任务:', EXPORT_WHICH, sfx ? '(成本测试，只有一小部分点)' : '');
  print('★ 跑完去 Tasks 看 EECU-seconds。随机点比例不能线性外推全量成本；');
  print('  成本试跑应打开 USE_PILOT_WINDOW，并使用一个连续的小多边形。');
}
