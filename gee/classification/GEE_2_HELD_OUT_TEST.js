/**********************************************************************
 * GEE classification export 2: geographically held-out countries
 * SA9 ASGM · v8 · 与训练侧 GEE_1_TRAIN.js v8 同架构
 * --------------------------------------------------------------------
 * 新建一个空脚本（例如 dissertation_test），整个贴进去。
 * 【不要】贴进 dissertation4 —— 训练与测试必须是两套独立的 Imports。
 *
 * --------------------------------------------------------------------
 * 【v8 测试侧相对 v5 的改动】
 *
 *  1.【AOI 方框】本脚本自动生成 7 个 110 x 110 km 的方框，和训练侧那
 *     7 个方框【尺寸完全一致、生成规则完全一致】。你只在方框里画标签，
 *     方框外的会被自动剔除并标红。这样论文里可以写成一条能复现的规则：
 *
 *       "Inference is restricted to 110 x 110 km square tiles centred on
 *        documented ASGM districts, defined identically in training and
 *        test countries."
 *
 *  2.【落在框内才算数】标签会被裁剪到方框边界内，保证导出的每一个像元
 *     都在 AOI 内，不会出现"评估范围和出图范围不一致"的问题。
 *
 *  3.【国家来自方框，不做几何查国界】GHA / IDN 不在南美九国资产里，
 *     所以国家代码直接由方框声明，既省算力又不会查错。
 *
 *  3b.【Cross-country transfer】training uses BRA/PER/COL/GUY/ECU;
 *     geographically held-out South American evaluation uses BOL/VEN/GUF/SUR.
 *
 *  4.【采样方式和训练侧逐字相同】先撒点再取值、经纬度做成波段、
 *     geometries:false、tileScale 16、按国家拆分导出。
 *     ★ 这一条很重要：训练和测试的采样方式必须一致，否则 T5/T6 的
 *       差异里会混进"采样方式不同"这个杂因。
 *
 *  5.【只导 AlphaEarth】不合成 Sentinel-2。与训练侧一致。
 *
 * --------------------------------------------------------------------
 * ★★ 三条不能违反的规则 ★★
 *   1. 画标签时【绝对不要】打开任何模型预测图层。用模型输出指导画标签
 *      = 循环论证，整个测试集作废。
 *   2. 方框位置一旦定下就【不许再挪】。看到结果不好回去挪框 =
 *      T5/T6 不再是独立测试。要挪，现在挪，画之前挪。
 *   3. 框里必须有【混淆源】—— 浑浊河、天然沙洲、农田、裸土、城镇。
 *      只框住矿会让测试集过于容易，分数虚高，一眼就被看穿。
 **********************************************************************/

// #####################################################################
// ⚙️  个人设置 —— 每次换新版本只需要检查这一块
// #####################################################################
// ★★ 0) 画标签模式 —— 这是让脚本变快的关键开关 ★★
//    你每画一个 polygon，GEE 都会把整个脚本【重跑一遍】。
//    标签图层和统计是最慢的部分（要做空间 join、裁剪、site 匹配）。
//    true  = 只留底图 + AOI 方框 + Dethier 参考点，画起来最快
//    false = 打开全部标签图层和统计，画完之后核对用
var DRAWING_MODE = false;

// 1) 底图：用不用缓存 Asset
//    true  = 从 projects/zcfaew0/assets/s2_2024_basemap 读，秒开（推荐）
//    false = 旱季影像现场 mosaic，慢，只在需要看瓦片以外的地方时用
//
//    ★ 和训练侧【共用同一个 collection】，不再单独建 _test 那个。
//      现在里面有 7 张，都是训练区的瓦片（Madre de Dios / Tapajós /
//      Rondônia / Roraima / Chocó / Bajo Cauca / Mazaruni）。
//      测试区的瓦片还没导的那些，测试框就是空白的 —— 这不是 bug。
//      ★ 缅甸瓦片需要单独导出一次
//        （把 EXPORT_BASEMAP_TILES 改 true，BASEMAP_TILES_ONLY 保持
//         ['MYANMAR']，导完改回 false）。
//      把 EXPORT_BASEMAP_TILES 打开跑一次，新瓦片会写进同一个
//      collection，跑完自动就有了，本项不用改。
//      Console 会打印每个测试框已经被几张缓存瓦片覆盖。
var USE_CACHED_BASEMAP = true;

// 1b) ★ 只在 AOI 方框内显示底图（和训练侧 'cached' 的观感一致）
//     true  = 只有方框里有影像，框外空白 —— 强烈建议保持 true
//     false = 整片大陆都渲染，非常慢，而且容易让你画到框外
var CLIP_BASEMAP_TO_AOI = true;

// 2) 跳到哪个测试区
//    T5（南美留出四国）: 'BOLIVIA' 'VENEZUELA' 'FRENCH_GUIANA' 'SURINAME'
//    T6（跨洲）:         'GHANA' 'INDONESIA' 'MYANMAR'
//    另有 'OVERVIEW'
var START_AT = 'BOLIVIA';

// 3) 要不要生成 CSV 导出任务（先 false 看数字，画完了再改 true）
var DO_EXPORT = false;

// 4) 每个 polygon 取多少采样点（★ 必须和训练侧一样）
var POINTS_PER_POLYGON_FAST = 200;
var POINTS_PER_POLYGON_FULL = 2000;

// 5) 按国家拆分导出（强烈建议保持 true）
var SPLIT_EXPORT_BY_COUNTRY = true;

// 6) 要不要导出【测试区】的 7 张底图瓦片（导完一次就改回 false）
//    ★ 不需要新建 collection —— 直接写进训练侧已有的那个
//      projects/zcfaew0/assets/s2_2024_basemap（现有 7 张，6.13 GB）。
//      测试瓦片名字和训练瓦片不冲突，跑完就是 14 张。
//    ★ 跑之前去 Tasks 历史看一眼训练那 7 张当时花了多少 EECU，同量级。
var EXPORT_BASEMAP_TILES = false;

// 6b) ★ 只导这几个框的底图瓦片。空数组 [] = 全导（7 张）。
//     缅甸是新加的，另外 7 张已经在 collection 里了，重导是纯浪费 EECU。
//     所以第一次为缅甸导图时，把上面改 true、这里保持 ['MYANMAR']，
//     导完再把上面改回 false。
var BASEMAP_TILES_ONLY = ['MYANMAR'];

// 7) 要不要把 AOI 方框本身导出（训练 8 框 + 测试 7 框）
//    论文 Fig. 3.1 研究区图、以及后面出预测图都要用到它
var EXPORT_AOI_BOXES = false;

// 8) 附加免费特征（★ 必须和训练侧一样，训练侧目前是 false）
var ADD_FREE_EXTRAS = false;

// 9) ★ 方框中心推荐 —— 按 Dethier 点密度自动算出每个国家最该放框的位置
//    打开后 Console 会打印一张表：手工中心 vs 推荐中心、各自框住几个参考点。
//    看完把推荐值粘回下面的 TEST_AOI，再把本项改成 false。
//    ★ 这条规则可以直接写进论文：方框中心 = 该国 Dethier 点在 55 km 半径内
//      邻居最多的那个点，完全可复现，不掺主观判断。
var RECOMMEND_CENTRES = false;

// 9b) ★ Amazon Mining Watch 矿痕参考图层（画 te_mine_footprint 的导航图）
//     由 amazon_basin_mining_scar_masks.tif 裁到四个测试框、筛掉 >2024、
//     去掉 <0.5 ha 的碎块后矢量化而来，共 2,128 个多边形。
//     ★ 只覆盖 BOL / VEN / GUF / SUR 四国 —— 厄瓜多尔、加纳、印尼不在
//       亚马逊流域内，AMW 没有数据，那三个框必须自己找矿。
//     ★ 它是【导航】不是【标签】：照着橙色轮廓画你自己的 te_mine_footprint，
//       口径要和训练侧的 tr_mine_footprint 一致（整片矿区复合体）。
var SHOW_AMW = true;
var AMW_ASSET = 'projects/zcfaew0/assets/amw_scar2024_test_boxes';

// 9c) 已导出的 AOI 方框 asset —— 只用来和脚本算出来的方框对照，
//     确认 asset 是不是最新坐标导的。默认关闭。
var SHOW_AOI_BOXES_ASSET = false;
var AOI_BOXES_ASSET = 'projects/zcfaew0/assets/sa9_v8_aoi_boxes';

// 10) ★ 把 AOI 方框裁剪到本国国界内
//     解决"法属圭亚那的框伸进苏里南、委内瑞拉的框伸进圭亚那"的问题。
//     裁剪后每个 AOI 严格属于一个国家，T5 的分国家归属才说得通。
//     论文里写成：110x110 km tiles clipped to the national boundary，
//     各框裁剪后的面积在表 3.2 里报告。
var CLIP_AOI_TO_COUNTRY = false;

// 11) 推荐中心时，要求方框至少这么大比例落在本国境内（0-1）
//     法属圭亚那的矿沿马罗尼河，那条河就是国界，所以这个值不能设太高。
var MIN_BOX_IN_COUNTRY = 0.45;
// #####################################################################


// =====================================================================
// 1. 基本配置 —— ★ 以下常量必须与 GEE_1_TRAIN.js 逐字一致
// =====================================================================
var YEAR = 2024;
var SCALE = 10;
var SAMPLE_SEED = 42;

var SMALL_POLYGON_HA = 5.0;
var LABEL_INSET_M = 10;
var MIN_AREA_FOR_INSET_M2 = 5000;

var DETHIER_SITE_MATCH_DISTANCE_M = 15000;
var FALLBACK_SITE_GRID_M = 10000;

var DRY_SEASON_START = '06-01';
var DRY_SEASON_END   = '10-01';
var FAST_CLOUD_PERCENT = 35;

var SOUTH_AMERICA_9_COUNTRIES_ASSET =
  'projects/zcfaew0/assets/south_america_9countries';
var DETHIER_ASGM_SITES_ASSET =
  'projects/zcfaew0/assets/asgm_global_sites';
// ★ 与训练侧共用同一个 collection，测试瓦片直接写进去
var BASEMAP_COLLECTION = 'projects/zcfaew0/assets/s2_2024_basemap';

var EXPORT_PREFIX = 'sa9_v8_test_' + YEAR;


// =====================================================================
// 2. ★ AOI 方框定义 —— 本版本的核心
// =====================================================================
// 训练侧的 7 个方框是这样来的（见 GEE_1_TRAIN.js 第 1 节）：
//   中心点 = 文献中有记载的 ASGM 矿区（Madre de Dios、Tapajós、
//            Rondônia、Roraima、Chocó、Bajo Cauca、Mazaruni），
//   方框   = 以该中心点为心的 110 x 110 km 正方形（半边长 55 km）。
// 也就是说：中心靠文献选，尺寸是固定的常数。不是随手画的。
//
// 测试侧沿用【同一条规则】，只把中心点换成 T5 / T6 国家的 ASGM 矿区。
// 这是 AOI 规则能写进论文的前提：train 和 test 必须用同一条规则。

var AOI_HALF_KM = 55;         // ★ 和训练侧 BASEMAP_TILE_HALF_KM 相同

// ★ 设计：南美九国 = 训练五国 (BRA/PER/COL/GUY/ECU) + 测试四国 (BOL/VEN/GUF/SUR)。
//   每个测试国家一个方框，T5 就成了"完整覆盖研究区剩余国家"的跨国迁移测试，
//   比随手挑三个国家好写得多。再加两个跨洲方框做 T6。
//   最终测试包含 7 框（T5 四个 + T6 三个）。
//
// T5 = 同洲跨国；T6 = 跨洲
var TEST_AOI = {
  // ---- T5：南美留出四国，一国一框 ----
  BOLIVIA:        {lon:  -67.95, lat: -15.30, zoom: 11, iso3: 'BOL', country: 'Bolivia', tier: 'T5',
                   district: 'Mapiri-Tipuani-Guanay-Kaka, La Paz'},
  VENEZUELA:      {lon:   -61.93, lat:     6.47, zoom: 11, iso3: 'VEN', country: 'Venezuela', tier: 'T5',
                   district: 'Arco Minero, W of Sifontes (lower Caroni-Imataca)'},
  FRENCH_GUIANA:  {lon:  -54.00, lat:   3.75, zoom: 11, iso3: 'GUF', country: 'French Guiana', tier: 'T5',
                   district: 'Upper Maroni-Lawa / Maripasoula'},
  SURINAME:       {lon:  -55.00, lat:   4.80, zoom: 11, iso3: 'SUR', country: 'Suriname', tier: 'T5',
                   district: 'Brokopondo / Brownsberg'},
  // ---- T6：跨洲 ----
  GHANA:          {lon:   -1.95, lat:   5.85, zoom: 12, iso3: 'GHA', country: 'Ghana', tier: 'T6',
                   district: 'Pra-Offin-Ankobra galamsey belt'},
  INDONESIA:      {lon:  113.60, lat:  -1.95, zoom: 12, iso3: 'IDN', country: 'Indonesia', tier: 'T6',
                   district: 'Galangan-Hampalit, Katingan, C. Kalimantan'},
  // ★ 第三个 T6 框：缅甸克钦邦。选点依据（都可写进论文）：
  //   - Connette et al. 2016, Remote Sensing 8(11):912 全国测到 52,312 ha
  //     高置信度矿区，实皆 + 克钦占 71%。
  //   - Indawgyi 湖南岸金矿区约 2,430 ha 已采，2022 年 191 台挖掘机，
  //     每年约 13.3 万吨泥沙入湖 —— 缅甸量化得最好的地表 ASGM 块。
  //   - 框内还含 Hawng Par (25.49N, 96.10E) 一带的上游 Uyu 河采金段。
  //   ★ 刻意把 Hpakant (25.61N, 96.31E) 排除在框外：那是全东南亚最大的
  //     露天开采景观，但采的是【翡翠不是金】，混进来标签就脏了。
  //     框的北边界 = 25.05 + 55/111 = 25.55N，正好在它南侧。
  //   ★ 备选中心（纯金、无翡翠风险，但呈河道线状、面积更薄）：
  //     密支那-Waingmaw-Myitsone {lon: 97.20, lat: 25.45}
  //     2021 年伊洛瓦底江上报道 >1,000 台采金船，Mali Hka 上 500-700 台。
  MYANMAR:        {lon:   96.30, lat:  25.05, zoom: 12, iso3: 'MMR', country: 'Myanmar', tier: 'T6',
                   lsib_alt: ['Burma'],
                   district: 'Indawgyi south goldfield & upper Uyu River, Kachin State'}
};

// 训练侧的 7 个框 —— 只用来在地图上对照显示 / 一起导出，不参与测试采样
var TRAIN_AOI = {
  MADRE_DE_DIOS: {lon: -70.1, lat: -12.9, iso3: 'PER'},
  TAPAJOS:       {lon: -56.3, lat:  -6.3, iso3: 'BRA'},
  RONDONIA:      {lon: -63.9, lat:  -9.2, iso3: 'BRA'},
  RORAIMA:       {lon: -62.2, lat:   3.4, iso3: 'BRA'},
  CHOCO:         {lon: -76.6, lat:   5.5, iso3: 'COL'},
  BAJO_CAUCA:    {lon: -75.0, lat:   7.9, iso3: 'COL'},
  MAZARUNI:      {lon: -59.6, lat:   6.2, iso3: 'GUY'},
  ECUADOR:       {lon: -79.07, lat:  0.85, iso3: 'ECU'}
};

var VIEWPOINTS = {OVERVIEW: {lon: -62.0, lat: 0.0, zoom: 4}};  // 南美全景，看 T5 四个框
Object.keys(TEST_AOI).forEach(function(k) { VIEWPOINTS[k] = TEST_AOI[k]; });

// ---- 由中心点 + 固定半边长生成方框（训练侧用的是同一个公式）--------
function makeBox(lon, lat, halfKm) {
  var halfDeg = halfKm / 111.0;
  var dx = halfDeg / Math.cos(lat * Math.PI / 180);
  // ★ 与 GEE_1_TRAIN.js 里生成底图瓦片的公式逐字相同，包括默认参数
  return ee.Geometry.Rectangle(
    [lon - dx, lat - halfDeg, lon + dx, lat + halfDeg]);
}

// 南美九国边界（和训练侧同一个资产）—— 裁剪方框要用，所以放在这里
var southAmerica9 = ee.FeatureCollection(SOUTH_AMERICA_9_COUNTRIES_ASSET);

// 取某个国家的国界。南美五国用九国资产（有 ISO_A3），加纳/印尼用 LSIB。
// simplify 到 5 km 是为了让后面的相交运算便宜，对 110 km 的方框没有影响。
// ★ 缅甸注意：LSIB_SIMPLE/2017 的 country_na 用的是美国国务院写法 'Burma'，
//   不是 'Myanmar'。所以这里改成按【候选名列表】过滤，两种写法都能命中，
//   以后再加国家也不会因为一个名字对不上而静默返回空几何。
function countryGeom(iso3, name, altNames) {
  var g;
  if (['BOL','ECU','VEN','GUF','SUR'].indexOf(iso3) >= 0) {
    g = southAmerica9.filter(ee.Filter.eq('ISO_A3', iso3)).geometry(1000);
  } else {
    var names = [name].concat(altNames || []);
    g = ee.FeatureCollection('USDOS/LSIB_SIMPLE/2017')
      .filter(ee.Filter.inList('country_na', names)).geometry(1000);
  }
  return g.simplify(5000);
}

var testBoxList = Object.keys(TEST_AOI).map(function(name) {
  var t = TEST_AOI[name];
  var raw = makeBox(t.lon, t.lat, AOI_HALF_KM);
  var cg = countryGeom(t.iso3, t.country, t.lsib_alt);
  // ★ 裁剪到国界：法属圭亚那的框不再伸进苏里南，委内瑞拉的框不再伸进圭亚那
  var geom = CLIP_AOI_TO_COUNTRY
    ? ee.Geometry(raw.intersection(cg, 200)) : raw;
  return ee.Feature(geom, {
    aoi_id: name, aoi_split: 'test', aoi_tier: t.tier,
    country_iso3: t.iso3, country: t.country, aoi_district: t.district,
    aoi_centre_lon: t.lon, aoi_centre_lat: t.lat,
    aoi_half_km: AOI_HALF_KM,
    aoi_area_km2: ee.Number(geom.area(200)).divide(1e6).round(),
    aoi_clipped: CLIP_AOI_TO_COUNTRY
  });
});
var testBoxes = ee.FeatureCollection(testBoxList);

var trainBoxList = Object.keys(TRAIN_AOI).map(function(name) {
  var t = TRAIN_AOI[name];
  return ee.Feature(makeBox(t.lon, t.lat, AOI_HALF_KM), {
    aoi_id: name, aoi_split: 'train', aoi_tier: 'T1-T4',
    country_iso3: t.iso3, aoi_district: name,
    aoi_centre_lon: t.lon, aoi_centre_lat: t.lat,
    aoi_half_km: AOI_HALF_KM
  });
});
var trainBoxes = ee.FeatureCollection(trainBoxList);
var allBoxes = trainBoxes.merge(testBoxes);

var testAoiGeom = testBoxes.geometry(1000);


// =====================================================================
// 3. 参考数据
// =====================================================================
// 全球国界 —— 加纳 / 印尼这两个 T6 方框不在南美资产里，用它补上
var worldBorders = ee.FeatureCollection('USDOS/LSIB_SIMPLE/2017')
  .filterBounds(testAoiGeom);

// Dethier 参考点 —— ★ 全球全部，不再按方框过滤。
// 用途有二：(1) 判断方框中心选得对不对；(2) 在框内按点去找矿。
// 这是纯矢量图层，画全球也几乎不花算力。
var dethierAll = ee.FeatureCollection(DETHIER_ASGM_SITES_ASSET)
  .map(function(f) {
    return f.set('dethier_site_id',
      ee.String('dethier_').cat(ee.String(f.get('system:index'))));
  });

// 落在测试方框内的那些，单独高亮一层，方便你看每个框覆盖了几个已知矿区。
var dethierInAoi = dethierAll.filterBounds(testAoiGeom);

// site_id 匹配用全集，不用过滤版 —— 方框边缘的 polygon 可能要匹配框外的点。
var dethierSites = dethierAll;


// ---------------------------------------------------------------------
// ★ 方框中心推荐 —— 用 Dethier 点密度定位每个测试国家的热点
// ---------------------------------------------------------------------
// 规则：在该国境内的 Dethier 点里，找【55 km 半径内邻居最多】的那一个，
// 用它当方框中心。55 km 正是方框的半边长，所以这条规则等价于
// "让方框框住尽可能多的已知矿区"。完全机械、可复现、不掺主观判断。
if (RECOMMEND_CENTRES && !DRAWING_MODE) {
  // 候选 = 该国境内的每一个 Dethier 点。
  // 打分 = 55 km 半径内的邻居数（55 km 正好是方框半边长，等价于
  //        "这个方框能框住多少已知矿区"）。
  // 约束 = 方框至少 MIN_BOX_IN_COUNTRY 的面积落在本国境内，
  //        避免推荐出一个大半在邻国的框。
  var recs = Object.keys(TEST_AOI).map(function(name) {
    var t = TEST_AOI[name];
    var cg = countryGeom(t.iso3, t.country, t.lsib_alt);
    var pts = dethierAll.filterBounds(cg);

    var scored = ee.FeatureCollection(ee.Join.saveAll('nbrs').apply({
      primary: pts, secondary: pts,
      condition: ee.Filter.withinDistance({
        distance: AOI_HALF_KM * 1000,
        leftField: '.geo', rightField: '.geo', maxError: 100})
    })).map(function(f) {
      var c = f.geometry().coordinates();
      var lon = ee.Number(c.get(0)), lat = ee.Number(c.get(1));
      var halfDeg = ee.Number(AOI_HALF_KM).divide(111.0);
      var dx = halfDeg.divide(lat.multiply(Math.PI / 180).cos());
      var box = ee.Geometry.Rectangle([lon.subtract(dx), lat.subtract(halfDeg),
                                       lon.add(dx), lat.add(halfDeg)]);
      var frac = ee.Number(box.intersection(cg, 500).area(500))
                   .divide(box.area(500));
      return f.set({
        n_within: ee.List(f.get('nbrs')).size(),
        lon: lon, lat: lat,
        frac_in_country: frac
      });
    }).filter(ee.Filter.gte('frac_in_country', MIN_BOX_IN_COUNTRY));

    var best = ee.Feature(ee.Algorithms.If(
      scored.size().gt(0),
      scored.sort('n_within', false).first(),
      ee.Feature(ee.Geometry.Point([0, 0]),
                 {n_within: 0, lon: 0, lat: 0, frac_in_country: 0})));

    var manualBox = makeBox(t.lon, t.lat, AOI_HALF_KM);
    var r2 = function(x) { return ee.Number(x).multiply(100).round().divide(100); };
    return ee.Feature(null, {
      aoi_id: name,
      dethier_in_country: pts.size(),
      manual_pts_in_box: dethierAll.filterBounds(manualBox).size(),
      SUGGEST_lon: r2(best.get('lon')),
      SUGGEST_lat: r2(best.get('lat')),
      SUGGEST_n_pts: best.get('n_within'),
      SUGGEST_frac_in_country: r2(ee.Number(best.get('frac_in_country')).multiply(100)),
      PASTE: ee.String('  ').cat(name).cat(': lon ')
        .cat(ee.Number(r2(best.get('lon'))).format('%.2f'))
        .cat(', lat ').cat(ee.Number(r2(best.get('lat'))).format('%.2f'))
        .cat('   (Dethier 点 ').cat(ee.Number(best.get('n_within')).format('%d'))
        .cat('，境内占比 ')
        .cat(ee.Number(best.get('frac_in_country')).multiply(100).format('%.0f'))
        .cat('%)')
    });
  });
  print('★★ 方框中心推荐 —— manual_pts_in_box 明显小于 SUGGEST_n_pts '
      + '就说明这个框放偏了:', ee.FeatureCollection(recs));
  print('★★ 直接可抄的坐标:',
        ee.FeatureCollection(recs).aggregate_array('PASTE'));
}

var LABEL_PROPERTIES = [
  'polygon_id','site_id','site_id_method','dethier_distance_m','source_id',
  'aoi_id','tier','country','country_iso3','country_label','country_binary',
  'region','year','split','label','class_id','binary',
  'positive_definition','polygon_area_ha'
];

var ALPHA_BANDS = [
  'A00','A01','A02','A03','A04','A05','A06','A07',
  'A08','A09','A10','A11','A12','A13','A14','A15',
  'A16','A17','A18','A19','A20','A21','A22','A23',
  'A24','A25','A26','A27','A28','A29','A30','A31',
  'A32','A33','A34','A35','A36','A37','A38','A39',
  'A40','A41','A42','A43','A44','A45','A46','A47',
  'A48','A49','A50','A51','A52','A53','A54','A55',
  'A56','A57','A58','A59','A60','A61','A62','A63'
];
var EXTRA_NAMES = ADD_FREE_EXTRAS
  ? ['elevation','slope','jrc_water_occurrence'] : [];


// =====================================================================
// 4. 底图（只用于显示，不进入导出）
// =====================================================================
function maskS2sr(image) {
  var scl = image.select('SCL');
  var bad = scl.eq(1).or(scl.eq(3)).or(scl.eq(8))
    .or(scl.eq(9)).or(scl.eq(10)).or(scl.eq(11));
  return image.updateMask(bad.not())
    .select(['B2','B3','B4','B8','B11','B12']).divide(10000)
    .copyProperties(image, ['system:time_start','CLOUDY_PIXEL_PERCENTAGE']);
}

var cachedCollection = ee.ImageCollection(BASEMAP_COLLECTION);
var s2Display, basemapMode;
if (USE_CACHED_BASEMAP) {
  s2Display = cachedCollection.mosaic().divide(10000);
  basemapMode = '缓存 Asset（零计算；未导瓦片的地方是空白，属正常）';
} else {
  s2Display = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterDate(YEAR + '-' + DRY_SEASON_START, YEAR + '-' + DRY_SEASON_END)
    .filterBounds(testAoiGeom)                     // ★ 只取压在方框上的影像
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', FAST_CLOUD_PERCENT))
    .map(maskS2sr).sort('CLOUDY_PIXEL_PERCENTAGE').mosaic();
  basemapMode = '旱季快速 mosaic（现场计算）';
}

// ★ 裁剪到 AOI 方框：框外空白，观感和训练侧的 'cached' 一致。
//   之前整片大陆都渲染 SWIR，就是因为少了这一步。
if (CLIP_BASEMAP_TO_AOI) {
  s2Display = s2Display.clip(testAoiGeom);
  basemapMode = basemapMode + ' · 已裁剪到 AOI 方框内';
} else {
  basemapMode = basemapMode + ' · ⚠️ 未裁剪，整片大陆都会渲染，很慢';
}

var dispNdti = s2Display.normalizedDifference(['B4','B3']).rename('NDTI');
var dispBsi = s2Display.expression(
  '((SWIR + RED) - (NIR + BLUE)) / ((SWIR + RED) + (NIR + BLUE))', {
    SWIR: s2Display.select('B11'), RED: s2Display.select('B4'),
    NIR: s2Display.select('B8'), BLUE: s2Display.select('B2')
  }).rename('BSI');

if (EXPORT_BASEMAP_TILES) {
  Object.keys(TEST_AOI).forEach(function(name) {
    if (BASEMAP_TILES_ONLY.length && BASEMAP_TILES_ONLY.indexOf(name) === -1) {
      return;   // 已经导过的瓦片跳过，不重复烧 EECU
    }
    var t = TEST_AOI[name];
    var region = makeBox(t.lon, t.lat, AOI_HALF_KM);
    Export.image.toAsset({
      image: ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterDate(YEAR + '-01-01', (YEAR + 1) + '-01-01')
        .filterBounds(region)
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 60))
        .map(maskS2sr).median().multiply(10000).toInt16().clip(region),
      description: 's2_basemap_test_' + name,
      assetId: BASEMAP_COLLECTION + '/' + name,   // 与训练瓦片同一 collection
      region: region, scale: 10, maxPixels: 1e13,
      pyramidingPolicy: {'.default': 'mean'}
    });
  });
}


// =====================================================================
// 5. 读取你画的 polygon
// =====================================================================
// 【第一次使用：建这 14 个 Import】
//   左上角 + new layer → 改名 → 选 Polygon → 先随便画一个小方块占位。
//   没建的会自动跳过，可以边建边画。
//   ★ 名字必须是 te_ 开头，和训练侧的 tr_ 区分开。
//
//   正类 A（整片矿区复合体，和训练侧同口径）
//     te_mine_footprint
//   正类 B（纯矿面 / 纯尾矿池）
//     te_mine_pure  te_mine_bareland_pure  te_mine_tailing_turbid_pure
//     te_tailing_darker_pure  te_mine_wetsediment_pure
//   负类（8 类，★ 是重点）
//     te_agri_neg   te_urban_neg ★   te_forest_neg   te_agwithinveg_neg
//     te_river_neg ★   te_river_turbid_neg ★★   te_grassland_neg
//     te_agrishoreline_neg

var LABEL_SPECS = [];
function reg(geom, sourceId, label, classId, binary, posDef) {
  if (geom !== undefined && geom !== null) {
    LABEL_SPECS.push({geometry: geom, sourceId: sourceId, label: label,
      classId: classId, binary: binary, positiveDefinition: posDef});
  }
}

reg(typeof te_mine_footprint !== 'undefined' ? te_mine_footprint : null,
    'te_mine_footprint', 'mine_complex_positive', 1, 1, 'A_complex');
reg(typeof te_mine_pure !== 'undefined' ? te_mine_pure : null,
    'te_mine_pure', 'mine_pure_positive', 10, 1, 'B_pure_surface');
reg(typeof te_mine_bareland_pure !== 'undefined' ? te_mine_bareland_pure : null,
    'te_mine_bareland_pure', 'mine_pure_bare_positive', 11, 1, 'B_pure_surface');
// ★ 两种拼法都接受：训练侧叫 tr_mine_tailing_turbid_pure，但 tr_tailing_darker_pure
//   没有 mine_ 前缀，很容易照着后者把测试图层建成 te_tailing_turbid_pure。
//   两个名字注册同一个类别，建了哪个都能读到。
reg(typeof te_mine_tailing_turbid_pure !== 'undefined' ? te_mine_tailing_turbid_pure : null,
    'te_mine_tailing_turbid_pure', 'mine_pure_pond_turbid_positive', 12, 1, 'B_pure_surface');
reg(typeof te_tailing_turbid_pure !== 'undefined' ? te_tailing_turbid_pure : null,
    'te_tailing_turbid_pure', 'mine_pure_pond_turbid_positive', 12, 1, 'B_pure_surface');
reg(typeof te_tailing_darker_pure !== 'undefined' ? te_tailing_darker_pure : null,
    'te_tailing_darker_pure', 'mine_pure_pond_dark_positive', 13, 1, 'B_pure_surface');
reg(typeof te_mine_wetsediment_pure !== 'undefined' ? te_mine_wetsediment_pure : null,
    'te_mine_wetsediment_pure', 'mine_pure_wetsediment_positive', 14, 1, 'B_pure_surface');

reg(typeof te_agri_neg !== 'undefined' ? te_agri_neg : null,
    'te_agri_neg', 'agriculture_negative', 2, 0, 'none');
reg(typeof te_urban_neg !== 'undefined' ? te_urban_neg : null,
    'te_urban_neg', 'urban_bare_negative', 3, 0, 'none');
reg(typeof te_forest_neg !== 'undefined' ? te_forest_neg : null,
    'te_forest_neg', 'forest_negative', 4, 0, 'none');
reg(typeof te_agwithinveg_neg !== 'undefined' ? te_agwithinveg_neg : null,
    'te_agwithinveg_neg', 'agriculture_within_vegetation_negative', 5, 0, 'none');
reg(typeof te_river_neg !== 'undefined' ? te_river_neg : null,
    'te_river_neg', 'river_negative', 6, 0, 'none');
reg(typeof te_river_turbid_neg !== 'undefined' ? te_river_turbid_neg : null,
    'te_river_turbid_neg', 'turbid_braided_river_negative', 7, 0, 'none');
reg(typeof te_grassland_neg !== 'undefined' ? te_grassland_neg : null,
    'te_grassland_neg', 'grassland_negative', 8, 0, 'none');
reg(typeof te_agrishoreline_neg !== 'undefined' ? te_agrishoreline_neg : null,
    'te_agrishoreline_neg', 'agriculture_shoreline_negative', 9, 0, 'none');

// Import 可以是 Geometry / Feature / FeatureCollection，三种都支持
function toGeometryParts(input) {
  var geom = (input && typeof input.geometry === 'function')
    ? ee.FeatureCollection(input).geometry(1)
    : ee.Geometry(input);
  return geom.geometries();
}

function explode(spec) {
  var parts = toGeometryParts(spec.geometry);
  var n = parts.size();
  var idx = ee.List(ee.Algorithms.If(
    n.gt(0), ee.List.sequence(0, n.subtract(1)), ee.List([])));

  return ee.FeatureCollection(idx.map(function(i) {
    i = ee.Number(i);
    var part = ee.Geometry(parts.get(i));
    return ee.Feature(part, {
      polygon_id: ee.String(spec.sourceId).cat('_p').cat(i.format('%03d')),
      source_id: spec.sourceId,
      label: spec.label,
      class_id: spec.classId,
      binary: spec.binary,
      positive_definition: spec.positiveDefinition,
      split: 'test',
      region: 'aoi_tile',
      year: YEAR,
      polygon_area_ha: part.area(1).divide(10000)
    });
  }));
}

var exploded = ee.FeatureCollection(LABEL_SPECS.map(explode)).flatten();


// =====================================================================
// 6. ★ 把每个 polygon 归到它所在的 AOI 方框，并裁剪到框内
// =====================================================================
// 国家代码直接来自方框声明，不做几何查国界：
//   (a) GHA / IDN 不在南美九国资产里，查不到；
//   (b) 方框就是我们声明的研究单元，用它更贴合论文里的 AOI 叙述；
//   (c) 省一次空间 join 的算力。
var joined = ee.FeatureCollection(ee.Join.saveFirst({matchKey: '_aoi'}).apply({
  primary: exploded,
  secondary: testBoxes,
  condition: ee.Filter.intersects({
    leftField: '.geo', rightField: '.geo', maxError: 10})
}));

var inAoi = joined.map(function(f) {
  var box = ee.Feature(f.get('_aoi'));
  var iso3 = ee.String(box.get('country_iso3'));
  // ★ 裁剪到方框内：保证导出的每一个像元都落在 AOI 里
  var clipped = f.geometry().intersection(box.geometry(), 10);
  return ee.Feature(clipped)
    .copyProperties(f, ['polygon_id','source_id','label','class_id','binary',
                        'positive_definition','split','region','year'])
    .set({
      aoi_id: box.get('aoi_id'),
      tier: box.get('aoi_tier'),
      country: box.get('country'),
      country_iso3: iso3,
      country_label: iso3.cat('_').cat(ee.String(f.get('label'))),
      country_binary: iso3.cat('_binary_')
        .cat(ee.Number(f.get('binary')).format()),
      polygon_area_ha: clipped.area(1).divide(10000)
    });
}).filter(ee.Filter.gt('polygon_area_ha', 0));

// 框外的 polygon —— 地图上标红，不进入导出
var matchedIds = inAoi.aggregate_array('polygon_id');
var rejectedPolygons = exploded.filter(
  ee.Filter.inList('polygon_id', matchedIds).not());


// ---- site_id（和训练侧同一套逻辑）----------------------------------
function spatialSiteId(feature, prefix) {
  var c = feature.geometry().centroid(100).transform('EPSG:3857', 100)
    .coordinates();
  var gx = ee.Number(c.get(0)).divide(FALLBACK_SITE_GRID_M).floor().format('%d');
  var gy = ee.Number(c.get(1)).divide(FALLBACK_SITE_GRID_M).floor().format('%d');
  return ee.String(prefix).cat('_')
    .cat(ee.String(feature.get('country_iso3')))
    .cat('_x').cat(gx).cat('_y').cat(gy);
}

function assignMineSite(feature) {
  var centroid = feature.geometry().centroid(100);
  var nearby = dethierSites.filterBounds(
    centroid.buffer(DETHIER_SITE_MATCH_DISTANCE_M, 100));
  var measured = nearby.map(function(s) {
    return s.set('_d', s.geometry().distance(centroid, 100));
  });
  var hasMatch = measured.size().gt(0);
  var nearest = ee.Feature(ee.Algorithms.If(hasMatch,
    measured.sort('_d').first(),
    ee.Feature(null, {dethier_site_id: 'none', _d: -1})));
  return feature.set({
    site_id: ee.Algorithms.If(hasMatch, nearest.get('dethier_site_id'),
      spatialSiteId(feature, 'mine_grid')),
    site_id_method: ee.Algorithms.If(hasMatch,
      'nearest_dethier_site', 'fallback_10km_grid'),
    dethier_distance_m: ee.Algorithms.If(hasMatch, nearest.get('_d'), -1)
  });
}

function assignNegativeSite(feature) {
  return feature.set({
    site_id: spatialSiteId(feature,
      ee.String('negative_').cat(ee.String(feature.get('label')))),
    site_id_method: 'class_10km_grid',
    dethier_distance_m: -1
  });
}

var testPolygons = inAoi.map(function(f) {
  return ee.Feature(ee.Algorithms.If(
    ee.Number(f.get('binary')).eq(1), assignMineSite(f), assignNegativeSite(f)));
});

var insetPolygons = testPolygons.map(function(f) {
  var original = f.geometry();
  var bigEnough = original.area(1).gte(MIN_AREA_FOR_INSET_M2);
  var inset = original.buffer(-LABEL_INSET_M, 1);
  var useInset = bigEnough.and(inset.area(1).gte(SCALE * SCALE));
  return ee.Feature(ee.Geometry(ee.Algorithms.If(useInset, inset, original)))
    .copyProperties(f, LABEL_PROPERTIES)
    .set('used_inset_geometry', useInset);
});


// =====================================================================
// 7. 特征影像 —— 只有 AlphaEarth（与训练侧逐字一致）
// =====================================================================
var predictorStack = ee.ImageCollection('GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL')
  .filterDate(YEAR + '-01-01', (YEAR + 1) + '-01-01')
  .filterBounds(testAoiGeom)
  .mosaic().select(ALPHA_BANDS).toFloat();

predictorStack = predictorStack.addBands(
  ee.Image.pixelLonLat().rename(['longitude','latitude']).toFloat());

if (ADD_FREE_EXTRAS) {
  var srtm = ee.Image('USGS/SRTMGL1_003');
  predictorStack = predictorStack
    .addBands(srtm.rename('elevation').toFloat())
    .addBands(ee.Terrain.slope(srtm).rename('slope').toFloat())
    .addBands(ee.Image('JRC/GSW1_4/GlobalSurfaceWater')
      .select('occurrence').unmask(0)
      .rename('jrc_water_occurrence').toFloat());
}


// =====================================================================
// 8. 采样 —— 先撒点再取值（与训练侧逐字一致）
// =====================================================================
var SAMPLE_PROPS = LABEL_PROPERTIES.concat(['used_inset_geometry']);

var smallPolygons = insetPolygons.filter(
  ee.Filter.lte('polygon_area_ha', SMALL_POLYGON_HA));
var largePolygons = insetPolygons.filter(
  ee.Filter.gt('polygon_area_ha', SMALL_POLYGON_HA));

function buildSamples(targetPoints) {
  var smallSamples = predictorStack.sampleRegions({
    collection: smallPolygons,
    properties: SAMPLE_PROPS,
    scale: SCALE,
    tileScale: 16,
    geometries: false
  });

  var count = largePolygons.size();
  var list = largePolygons.toList(count);
  var indices = ee.List(ee.Algorithms.If(
    count.gt(0), ee.List.sequence(0, count.subtract(1)), ee.List([])));

  var pointSets = indices.map(function(i) {
    i = ee.Number(i);
    var f = ee.Feature(list.get(i));
    var nPix = ee.Number(f.get('polygon_area_ha')).multiply(100).toInt();
    var n = ee.Number(targetPoints).min(nPix).max(1).toInt();
    return ee.FeatureCollection.randomPoints(
        f.geometry(), n, ee.Number(SAMPLE_SEED).add(i), 1)
      .map(function(p) { return p.copyProperties(f, SAMPLE_PROPS); });
  });
  var points = ee.FeatureCollection(pointSets).flatten();

  var largeSamples = predictorStack.sampleRegions({
    collection: points,
    properties: SAMPLE_PROPS,
    scale: SCALE,
    tileScale: 16,
    geometries: false
  });

  return smallSamples.merge(largeSamples);
}

var samplesFast = buildSamples(POINTS_PER_POLYGON_FAST);
var samplesFull = buildSamples(POINTS_PER_POLYGON_FULL);


// =====================================================================
// 9. 地图 —— 画 polygon 的工作台
// =====================================================================
var v = VIEWPOINTS[START_AT];
Map.setCenter(v.lon, v.lat, v.zoom);
Map.setOptions('SATELLITE');

Map.addLayer(s2Display, {bands: ['B12','B8','B4'], min: 0.02, max: 0.40},
  '★ S2 2024 SWIR 假彩色（矿面呈粉紫）', true);
Map.addLayer(s2Display, {bands: ['B4','B3','B2'], min: 0.02, max: 0.30},
  'S2 2024 真彩色', false);
Map.addLayer(s2Display, {bands: ['B8','B11','B4'], min: 0.02, max: 0.45},
  'S2 2024 农业假彩色', false);
Map.addLayer(dispNdti, {min: -0.3, max: 0.3,
  palette: ['0571b0','92c5de','f7f7f7','f4a582','ca0020']}, 'NDTI 浑浊度', false);
Map.addLayer(dispBsi, {min: -0.3, max: 0.4,
  palette: ['1a9850','ffffbf','d73027']}, 'BSI 裸土指数', false);

// ★ AOI 方框 —— 只在青色框内画标签
Map.addLayer(trainBoxes.style(
  {color: '888888', fillColor: '00000000', width: 1}), {},
  '训练 AOI 方框（7 个，仅供对照）', true);
Map.addLayer(testBoxes.style(
  {color: '00e5ff', fillColor: '00000000', width: 3}), {},
  '★ 测试 AOI 方框（只在框内画）', true);
Map.addLayer(southAmerica9.style(
  {color: 'ffffff', fillColor: '00000000', width: 2}), {}, '南美九国边界', true);
Map.addLayer(worldBorders.style(
  {color: 'ffffff', fillColor: '00000000', width: 1}), {},
  '全球国界（给 T6 的加纳 / 印尼用）', true);
// 全球全部参考点（暗黄，小），用来判断方框位置选得准不准
Map.addLayer(dethierAll, {color: 'b38f00'}, 'Dethier 参考点（全球全部）', true);
// 落在测试方框内的（亮黄），这些就是你要去找矿的地方
Map.addLayer(dethierInAoi, {color: 'ffcc00'}, '★ Dethier 参考点（落在测试框内）', true);

// ---- AMW 矿痕参考（★ 画标签的导航图，DRAWING_MODE 下也保留）--------
if (SHOW_AMW) {
  var amw = ee.FeatureCollection(AMW_ASSET);
  Map.addLayer(amw.style({color: 'ff8f00', fillColor: 'ff8f0033', width: 2}), {},
    '★ AMW 矿痕参考 ≤2024（照着它画，仅 BOL/VEN/GUF/SUR）', true);
}
if (SHOW_AOI_BOXES_ASSET) {
  Map.addLayer(ee.FeatureCollection(AOI_BOXES_ASSET).style(
    {color: 'ff00ff', fillColor: '00000000', width: 1}), {},
    'AOI 方框（asset 版，仅对照）', false);
}


// ---- 标签图层 ----------------------------------------------------
// ★ 全部默认关闭。原因：GEE 在你每画一个 polygon 之后都会重跑整个脚本，
//   这些图层要走空间 join、裁剪和 site 匹配，是最拖慢绘制的部分。
//   画完要核对时，把 DRAWING_MODE 改成 false 再 Run。
if (!DRAWING_MODE) {
Map.addLayer(testPolygons.filter(
  ee.Filter.eq('positive_definition','A_complex')),
  {color: '7cff00'}, '正类 A：整片矿区复合体', false);
Map.addLayer(testPolygons.filter(
  ee.Filter.eq('label','mine_pure_bare_positive')),
  {color: 'ffea00'}, '正类 B：纯裸矿面', false);
Map.addLayer(testPolygons.filter(ee.Filter.inList('label',
  ['mine_pure_pond_turbid_positive','mine_pure_pond_dark_positive',
   'mine_pure_positive','mine_pure_wetsediment_positive'])),
  {color: 'ff6d00'}, '正类 B：纯尾矿池 / 湿沉积', false);
Map.addLayer(testPolygons.filter(
  ee.Filter.eq('label','turbid_braided_river_negative')),
  {color: 'ffb300'}, '负类：浑浊/辫状河 ★★', false);
Map.addLayer(testPolygons.filter(
  ee.Filter.eq('label','urban_bare_negative')),
  {color: '00e5ff'}, '负类：城市/裸地 ★', false);
Map.addLayer(testPolygons.filter(
  ee.Filter.eq('label','river_negative')),
  {color: '2979ff'}, '负类：清澈河流 ★', false);
Map.addLayer(testPolygons.filter(ee.Filter.inList('label',
  ['agriculture_negative','forest_negative','grassland_negative',
   'agriculture_within_vegetation_negative',
   'agriculture_shoreline_negative'])),
  {color: '9e9e9e'}, '负类：其余五类', false);
Map.addLayer(rejectedPolygons, {color: 'ff0000'}, '❌ 画到 AOI 方框外', false);
}



// =====================================================================
// 10. 诊断 —— 纯矢量，不采样，不花算力
// =====================================================================
print('底图模式:', basemapMode);
print('=== GEE 脚本 2（v8）：测试侧 · AOI 方框版 ===');
print('--- AOI ---');
print('方框规则: 以文献记载的 ASGM 矿区为中心，'
  + (AOI_HALF_KM * 2) + ' x ' + (AOI_HALF_KM * 2) + ' km 正方形');
print('测试方框数:', testBoxes.size(), ' 训练方框数:', trainBoxes.size());
print('裁剪到国界:', CLIP_AOI_TO_COUNTRY ? '是（每个 AOI 严格属于一个国家）' : '否');
print('各测试框裁剪后的面积 (km²):',
  testBoxes.select(['aoi_id','country_iso3','aoi_area_km2']));
print('单框面积 (km²):', Math.pow(AOI_HALF_KM * 2, 2));
print('测试 AOI 总面积 (km²):', Math.pow(AOI_HALF_KM * 2, 2) * Object.keys(TEST_AOI).length);
print('训练 AOI 总面积 (km²):', Math.pow(AOI_HALF_KM * 2, 2) * Object.keys(TRAIN_AOI).length);
print('每个测试方框最近的 Dethier 参考点距离 (m)（论文里用来说明中心点不是随手选的）:',
  testBoxes.map(function(b) {
    var c = b.geometry().centroid(100);
    var near = ee.FeatureCollection(DETHIER_ASGM_SITES_ASSET)
      .filterBounds(c.buffer(200000, 1000))
      .map(function(s) { return s.set('_d', s.geometry().distance(c, 100)); });
    return ee.Feature(null, {
      aoi_id: b.get('aoi_id'),
      nearest_dethier_m: ee.Algorithms.If(near.size().gt(0),
        ee.Number(near.aggregate_min('_d')).round(), -1)
    });
  }));

if (SHOW_AMW && !DRAWING_MODE) {
  var amwD = ee.FeatureCollection(AMW_ASSET);
  print('--- AMW 矿痕参考 ---');
  print('多边形总数（应为 2128）:', amwD.size());
  print('按 AOI 的多边形数:', amwD.aggregate_histogram('aoi_id'));
}

print('--- 底图缓存 ---');
print('缓存 collection:', BASEMAP_COLLECTION);
print('里面现有瓦片数:', cachedCollection.size(), '（训练区 7 张已在其中）');
print('每个测试框已被几张缓存瓦片覆盖（0 = 还没导，框内会是空白）:',
  testBoxes.map(function(b) {
    return ee.Feature(null, {
      aoi_id: b.get('aoi_id'),
      cached_tiles: cachedCollection.filterBounds(b.geometry()).size()
    });
  }));

print('全球 Dethier 参考点总数:', dethierAll.size());
print('落在测试方框内的参考点数:', dethierInAoi.size());
print('每个测试方框内的参考点数:', testBoxes.map(function(b) {
  return ee.Feature(null, {
    aoi_id: b.get('aoi_id'),
    dethier_points_in_box: dethierAll.filterBounds(b.geometry()).size()
  });
}));

// ★ polygon 统计同样默认关闭 —— 每画一个 polygon 这些都会重算一遍。
//   画完要核对数量时把 DRAWING_MODE 改成 false 再 Run。
if (DRAWING_MODE) {
  print('✏️ DRAWING_MODE = true：标签图层与统计已关闭，画起来会快很多。');
  print('   画完之后把 DRAWING_MODE 改成 false，Run 一次核对数量，再导出。');
} else {
  print('--- polygon ---');
  print('已读到的 Import 数:', LABEL_SPECS.length);
  // ★ 明确列出哪些注册名没有对应的 Import，避免图层被静默丢掉
  var ALL_REG = ['te_mine_footprint','te_mine_pure','te_mine_bareland_pure',
    'te_mine_tailing_turbid_pure','te_tailing_turbid_pure','te_tailing_darker_pure',
    'te_mine_wetsediment_pure','te_agri_neg','te_urban_neg','te_forest_neg',
    'te_agwithinveg_neg','te_river_neg','te_river_turbid_neg','te_grassland_neg',
    'te_agrishoreline_neg'];
  var found = LABEL_SPECS.map(function(x) { return x.sourceId; });
  var missing = ALL_REG.filter(function(n) { return found.indexOf(n) === -1; });
  print('✅ 读到的图层:', found);
  print('⚠️ 没有建（或名字对不上）的图层:', missing);
  print('画的 polygon 总数:', exploded.size());
  print('落在 AOI 方框内的:', testPolygons.size());
  print('❌ 画到框外被剔除的:', rejectedPolygons.size());
  print('按 AOI 的 polygon 数:', testPolygons.aggregate_histogram('aoi_id'));
  print('按类别的 polygon 数:', testPolygons.aggregate_histogram('label'));
  print('按 tier 的 polygon 数:', testPolygons.aggregate_histogram('tier'));
  print('独立 site 数:', testPolygons.distinct(['site_id']).size());
  print('小 polygon（≤' + SMALL_POLYGON_HA + ' ha，全像元取）:', smallPolygons.size());
  print('大 polygon（撒点取）:', largePolygons.size());

  print('--- 导出规模 ---');
  print('特征: AlphaEarth ' + ALPHA_BANDS.length + ' 维'
    + (ADD_FREE_EXTRAS ? ' + 高程/坡度/JRC 水体' : '（不含 Sentinel-2）'));
  print('★ FAST 预估行数 ≈',
    largePolygons.size().multiply(POINTS_PER_POLYGON_FAST)
      .add(smallPolygons.aggregate_sum('polygon_area_ha').multiply(100).toInt()));
  print('★ FULL 预估行数 ≈',
    largePolygons.size().multiply(POINTS_PER_POLYGON_FULL)
      .add(smallPolygons.aggregate_sum('polygon_area_ha').multiply(100).toInt()));
}


// =====================================================================
// 11. 导出
// =====================================================================
var selectors = LABEL_PROPERTIES
  .concat(['used_inset_geometry'])
  .concat(['longitude','latitude'])
  .concat(ALPHA_BANDS).concat(EXTRA_NAMES);

// 去重：万一以后同一个国家放了两个方框，也只会生成一个导出任务
var TEST_COUNTRY_ISO3 = [];
Object.keys(TEST_AOI).forEach(function(k) {
  var iso = TEST_AOI[k].iso3;
  if (TEST_COUNTRY_ISO3.indexOf(iso) === -1) { TEST_COUNTRY_ISO3.push(iso); }
});

function exportOne(collection, tag) {
  Export.table.toDrive({
    collection: collection,
    description: EXPORT_PREFIX + '_' + tag,
    fileNamePrefix: EXPORT_PREFIX + '_' + tag,
    fileFormat: 'CSV',
    selectors: selectors
  });
}

if (DO_EXPORT) {
  if (SPLIT_EXPORT_BY_COUNTRY) {
    TEST_COUNTRY_ISO3.forEach(function(iso) {
      exportOne(samplesFast.filter(ee.Filter.eq('country_iso3', iso)),
                'fast_' + iso);
    });
    TEST_COUNTRY_ISO3.forEach(function(iso) {
      exportOne(samplesFull.filter(ee.Filter.eq('country_iso3', iso)),
                'full_' + iso);
    });
  } else {
    exportOne(samplesFast, 'fast');
    exportOne(samplesFull, 'full');
  }

  Export.table.toDrive({
    collection: testPolygons,
    description: EXPORT_PREFIX + '_polygons',
    fileNamePrefix: EXPORT_PREFIX + '_polygons',
    fileFormat: 'GeoJSON'
  });
}

if (EXPORT_AOI_BOXES) {
  // 论文 Fig. 3.1 研究区图 + 后面出预测图都要用它
  Export.table.toDrive({
    collection: allBoxes,
    description: 'sa9_v8_aoi_boxes',
    fileNamePrefix: 'sa9_v8_aoi_boxes',
    fileFormat: 'GeoJSON'
  });
  Export.table.toAsset({
    collection: allBoxes,
    description: 'sa9_v8_aoi_boxes_asset',
    assetId: 'projects/zcfaew0/assets/sa9_v8_aoi_boxes'
  });
}
