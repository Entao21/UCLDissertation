/**********************************************************************
 * GEE 脚本 1 / 2 ——【训练侧】标注工作台 + AlphaEarth 特征导出
 * SA9 ASGM · v8 · 省算力 + 分批导出
 * --------------------------------------------------------------------
 * 整个贴进 dissertation4 覆盖原有内容。Geometry Imports 不要动。
 *
 * v7 相对 v6 的两个关键改动（成本降约 100 倍）：
 *
 *  1. 【先撒点，再取值】
 *     v6 的做法是给 polygon 内每一个像元算特征，再用掩膜扔掉 99.8%。
 *     GEE 实际计算了 1.53 亿个像元，只输出 8 万行 —— 这就是 22 万 EECU 的来源。
 *     v7 改成：先在 polygon 内随机撒出目标数量的点（纯矢量运算，几乎零成本），
 *     只在这些点的位置上取值。GEE 只需要算 8 万个位置。
 *
 *  2. 【经纬度做成波段，不携带几何】
 *     v7 用 geometries:true 取经纬度，导致每一行都带着完整几何对象。
 *     8 万行 x 64 个浮点 + 几何 + 文本属性 ≈ 65 MB，超过了 GEE 单次
 *     reduceRegions 返回值的上限（报错 "Computed value is too large"）。
 *     v8 把经纬度做成两个普通波段，geometries:false，体积降三成。
 *
 *  3. 【按国家拆成 5 个导出任务】
 *     每个约 1.5 万行，稳稳低于上限。Colab 合并只要两行代码。
 *
 *  4. 【只读 AlphaEarth，不合成 Sentinel-2】
 *     AlphaEarth 是预先算好存着的年度 Asset，读它 = 读文件，很便宜。
 *     Sentinel-2 要现场合成（每个像元读二三十景影像再排序），是主要成本。
 *     Sentinel-2 只保留在地图显示上，而且是从你已导出的底图 Asset 读的。
 **********************************************************************/

// #####################################################################
// ⚙️  个人设置 —— 每次换新版本只需要检查这一块
// #####################################################################
// 1) 底图（只影响你看到什么，不影响导出的数据）
//    'cached' = 从已导出的 8 块 Asset 读，秒开（瓦片外空白属正常）
//    'fast'   = 旱季低云影像直接 mosaic（会现场计算，看别处时才用）
var BASEMAP_MODE = 'cached';

// 2) 跳到哪个矿区
//    'MADRE_DE_DIOS' 'TAPAJOS' 'RONDONIA' 'RORAIMA' 'CHOCO'
//    'BAJO_CAUCA' 'MAZARUNI' 'ECUADOR' 'OVERVIEW'
var START_AT = 'MADRE_DE_DIOS';

// 3) 要不要生成 CSV 导出任务（先 false 看数字，确认后改 true）
var DO_EXPORT = false;

// 4) 每个 polygon 取多少个采样点
var POINTS_PER_POLYGON_FAST = 200;    // ≈ 5 万行，先跑这个
var POINTS_PER_POLYGON_FULL = 2000;   // ≈ 50 万行，确认成本低之后再跑

// 4b) 按国家拆分导出。每个国家一个 CSV，避免单次返回值超限。
//     强烈建议保持 true。Colab 里会自动把五个文件合并。
var SPLIT_EXPORT_BY_COUNTRY = true;

// 5) 要不要顺带导三个"免费"特征：高程、坡度、JRC 地表水出现频率。
//    这三个也都是预先存好的 Asset，读取成本几乎为零，不做任何合成。
//    设 true 可以给论文提供一个最低限度的非 AlphaEarth 对照组。
var ADD_FREE_EXTRAS = false;

// 6) 要不要生成底图缓存导出任务（导完一次就改回 false）
var EXPORT_BASEMAP_TILES = false;
// #####################################################################


// =====================================================================
// 1. 基本配置
// =====================================================================
var YEAR = 2024;
var SCALE = 10;
var SAMPLE_SEED = 42;

// 小 polygon 直接把每个像元都取出来（面积小，很便宜，而且没有重复点问题）；
// 大 polygon 才用撒点的方式。
var SMALL_POLYGON_HA = 5.0;

// polygon 向内缩 10 m 去边缘混合像元，但只对够大的做，
// 否则 30–40 m 宽的小尾矿池会被缩没。
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
var BASEMAP_COLLECTION = 'projects/zcfaew0/assets/s2_2024_basemap';

var TRAIN_COUNTRY_ISO3 = ['BRA', 'PER', 'COL', 'GUY', 'ECU'];
var EXPORT_PREFIX = 'sa9_v8_train_' + YEAR;

var VIEWPOINTS = {
  OVERVIEW:      {lon: -61.0, lat:  -7.0, zoom: 4},
  MADRE_DE_DIOS: {lon: -70.1, lat: -12.9, zoom: 11},
  TAPAJOS:       {lon: -56.3, lat:  -6.3, zoom: 11},
  RONDONIA:      {lon: -63.9, lat:  -9.2, zoom: 11},
  RORAIMA:       {lon: -62.2, lat:   3.4, zoom: 11},
  CHOCO:         {lon: -76.6, lat:   5.5, zoom: 11},
  BAJO_CAUCA:    {lon: -75.0, lat:   7.9, zoom: 11},
  MAZARUNI:      {lon: -59.6, lat:   6.2, zoom: 11},
  ECUADOR:       {lon: -79.07, lat:  0.85, zoom: 11}
};
var BASEMAP_TILE_NAMES = ['MADRE_DE_DIOS','TAPAJOS','RONDONIA','RORAIMA',
                          'CHOCO','BAJO_CAUCA','MAZARUNI','ECUADOR'];
var BASEMAP_TILE_HALF_KM = 55;

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

var LABEL_PROPERTIES = [
  'polygon_id','site_id','site_id_method','dethier_distance_m','source_id',
  'country','country_iso3','country_label','country_binary','region','year',
  'split','label','class_id','binary','positive_definition','polygon_area_ha'
];


// =====================================================================
// 2. 参考数据
// =====================================================================
var southAmerica9 = ee.FeatureCollection(SOUTH_AMERICA_9_COUNTRIES_ASSET);
var aoi = southAmerica9.geometry(1000);

var dethierSites = ee.FeatureCollection(DETHIER_ASGM_SITES_ASSET)
  .filterBounds(aoi)
  .map(function(f) {
    return f.set('dethier_site_id',
      ee.String('dethier_').cat(ee.String(f.get('system:index'))));
  });


// =====================================================================
// 3. 地图底图（只用于显示，不进入导出）
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
if (BASEMAP_MODE === 'cached') {
  s2Display = cachedCollection.mosaic().divide(10000);
  basemapMode = '缓存 Asset（零计算，只覆盖已导出的 8 块瓦片）';
} else {
  s2Display = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterDate(YEAR + '-' + DRY_SEASON_START, YEAR + '-' + DRY_SEASON_END)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', FAST_CLOUD_PERCENT))
    .map(maskS2sr).sort('CLOUDY_PIXEL_PERCENTAGE').mosaic();
  basemapMode = '旱季快速 mosaic（会现场计算，只在需要看别处时用）';
}

var dispNdti = s2Display.normalizedDifference(['B4','B3']).rename('NDTI');
var dispBsi = s2Display.expression(
  '((SWIR + RED) - (NIR + BLUE)) / ((SWIR + RED) + (NIR + BLUE))', {
    SWIR: s2Display.select('B11'), RED: s2Display.select('B4'),
    NIR: s2Display.select('B8'), BLUE: s2Display.select('B2')
  }).rename('BSI');

if (EXPORT_BASEMAP_TILES) {
  BASEMAP_TILE_NAMES.forEach(function(name) {
    var t = VIEWPOINTS[name];
    var halfDeg = BASEMAP_TILE_HALF_KM / 111.0;
    var dx = halfDeg / Math.cos(t.lat * Math.PI / 180);
    var region = ee.Geometry.Rectangle(
      [t.lon - dx, t.lat - halfDeg, t.lon + dx, t.lat + halfDeg]);
    Export.image.toAsset({
      image: ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterDate(YEAR + '-01-01', (YEAR + 1) + '-01-01')
        .filterBounds(region)
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 60))
        .map(maskS2sr).median().multiply(10000).toInt16().clip(region),
      description: 's2_basemap_train_' + name,
      assetId: BASEMAP_COLLECTION + '/' + name,
      region: region, scale: 10, maxPixels: 1e13,
      pyramidingPolicy: {'.default': 'mean'}
    });
  });
}


// =====================================================================
// 4. 读取你画的 polygon
// =====================================================================
var LABEL_SPECS = [];
function reg(geom, sourceId, label, classId, binary, posDef) {
  if (geom !== undefined && geom !== null) {
    LABEL_SPECS.push({geometry: geom, sourceId: sourceId, label: label,
      classId: classId, binary: binary, positiveDefinition: posDef});
  }
}

reg(typeof tr_mine_footprint !== 'undefined' ? tr_mine_footprint : null,
    'tr_mine_footprint', 'mine_complex_positive', 1, 1, 'A_complex');
reg(typeof tr_mine_pure !== 'undefined' ? tr_mine_pure : null,
    'tr_mine_pure', 'mine_pure_positive', 10, 1, 'B_pure_surface');
reg(typeof tr_mine_bareland_pure !== 'undefined' ? tr_mine_bareland_pure : null,
    'tr_mine_bareland_pure', 'mine_pure_bare_positive', 11, 1, 'B_pure_surface');
reg(typeof tr_mine_tailing_turbid_pure !== 'undefined' ? tr_mine_tailing_turbid_pure : null,
    'tr_mine_tailing_turbid_pure', 'mine_pure_pond_turbid_positive', 12, 1, 'B_pure_surface');
reg(typeof tr_tailing_darker_pure !== 'undefined' ? tr_tailing_darker_pure : null,
    'tr_tailing_darker_pure', 'mine_pure_pond_dark_positive', 13, 1, 'B_pure_surface');
reg(typeof tr_mine_wetsediment_pure !== 'undefined' ? tr_mine_wetsediment_pure : null,
    'tr_mine_wetsediment_pure', 'mine_pure_wetsediment_positive', 14, 1, 'B_pure_surface');

reg(typeof tr_agri_neg !== 'undefined' ? tr_agri_neg : null,
    'tr_agri_neg', 'agriculture_negative', 2, 0, 'none');
reg(typeof tr_urban_neg !== 'undefined' ? tr_urban_neg : null,
    'tr_urban_neg', 'urban_bare_negative', 3, 0, 'none');
reg(typeof tr_forest_neg !== 'undefined' ? tr_forest_neg : null,
    'tr_forest_neg', 'forest_negative', 4, 0, 'none');
reg(typeof tr_agwithinveg_neg !== 'undefined' ? tr_agwithinveg_neg : null,
    'tr_agwithinveg_neg', 'agriculture_within_vegetation_negative', 5, 0, 'none');
reg(typeof tr_river_neg !== 'undefined' ? tr_river_neg : null,
    'tr_river_neg', 'river_negative', 6, 0, 'none');
reg(typeof tr_river_turbid_neg !== 'undefined' ? tr_river_turbid_neg : null,
    'tr_river_turbid_neg', 'turbid_braided_river_negative', 7, 0, 'none');
reg(typeof tr_grassland_neg !== 'undefined' ? tr_grassland_neg : null,
    'tr_grassland_neg', 'grassland_negative', 8, 0, 'none');
reg(typeof tr_agrishoreline_neg !== 'undefined' ? tr_agrishoreline_neg : null,
    'tr_agrishoreline_neg', 'agriculture_shoreline_negative', 9, 0, 'none');

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
    var centroid = part.centroid(100);
    var matches = southAmerica9.filterBounds(centroid);
    var country = ee.Feature(ee.Algorithms.If(
      matches.size().gt(0), matches.first(),
      ee.Feature(null, {NAME: 'unknown', ISO_A3: 'UNK'})));
    var iso3 = ee.String(country.get('ISO_A3'));

    return ee.Feature(part, {
      polygon_id: ee.String(spec.sourceId).cat('_p').cat(i.format('%03d')),
      source_id: spec.sourceId,
      label: spec.label,
      class_id: spec.classId,
      binary: spec.binary,
      positive_definition: spec.positiveDefinition,
      split: 'train',
      region: 'south_america_train',
      year: YEAR,
      country: country.get('NAME'),
      country_iso3: iso3,
      country_label: iso3.cat('_').cat(spec.label),
      country_binary: iso3.cat('_binary_').cat(ee.Number(spec.binary).format()),
      polygon_area_ha: part.area(1).divide(10000)
    });
  }));
}

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

var exploded = ee.FeatureCollection(LABEL_SPECS.map(explode)).flatten();
var allDrawn = exploded.map(function(f) {
  return ee.Feature(ee.Algorithms.If(
    ee.Number(f.get('binary')).eq(1), assignMineSite(f), assignNegativeSite(f)));
});

var trainPolygons = allDrawn.filter(
  ee.Filter.inList('country_iso3', TRAIN_COUNTRY_ISO3));
var rejectedPolygons = allDrawn.filter(
  ee.Filter.inList('country_iso3', TRAIN_COUNTRY_ISO3).not());

var insetPolygons = trainPolygons.map(function(f) {
  var original = f.geometry();
  var bigEnough = original.area(1).gte(MIN_AREA_FOR_INSET_M2);
  var inset = original.buffer(-LABEL_INSET_M, 1);
  var useInset = bigEnough.and(inset.area(1).gte(SCALE * SCALE));
  return ee.Feature(ee.Geometry(ee.Algorithms.If(useInset, inset, original)))
    .copyProperties(f, LABEL_PROPERTIES)
    .set('used_inset_geometry', useInset);
});


// =====================================================================
// 5. 特征影像 —— 只有 AlphaEarth（预存 Asset，读取便宜）
// =====================================================================
var predictorStack = ee.ImageCollection('GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL')
  .filterDate(YEAR + '-01-01', (YEAR + 1) + '-01-01')
  .filterBounds(aoi)
  .mosaic().select(ALPHA_BANDS).toFloat();

// 经纬度做成普通波段 —— 这样不需要 geometries:true 携带几何对象，
// 输出体积大幅下降，也不会撞上"返回值过大"的限制。
predictorStack = predictorStack.addBands(
  ee.Image.pixelLonLat().rename(['longitude','latitude']).toFloat());

if (ADD_FREE_EXTRAS) {
  // 这三个也都是预存 Asset，不做任何影像合成，成本接近零
  var srtm = ee.Image('USGS/SRTMGL1_003');
  predictorStack = predictorStack
    .addBands(srtm.rename('elevation').toFloat())
    .addBands(ee.Terrain.slope(srtm).rename('slope').toFloat())
    .addBands(ee.Image('JRC/GSW1_4/GlobalSurfaceWater')
      .select('occurrence').unmask(0)
      .rename('jrc_water_occurrence').toFloat());
}


// =====================================================================
// 6. 采样 —— 先撒点，再取值
// =====================================================================
// 这是 v7 省算力的关键。
//   小 polygon（≤5 ha）：直接把每个像元取出来。面积小所以便宜，
//                        而且不会有"两个点落进同一格子"的重复问题。
//   大 polygon（>5 ha）：先在里面随机撒出目标数量的点（纯矢量运算），
//                        再只在这些点上读 AlphaEarth。
// 两种方式取出来的都是真实像元，坐标 / polygon_id / site_id 全部保留，
// 所以 T1–T6 的划分设计完全不受影响。

var SAMPLE_PROPS = LABEL_PROPERTIES.concat(['used_inset_geometry']);

var smallPolygons = insetPolygons.filter(
  ee.Filter.lte('polygon_area_ha', SMALL_POLYGON_HA));
var largePolygons = insetPolygons.filter(
  ee.Filter.gt('polygon_area_ha', SMALL_POLYGON_HA));

function buildSamples(targetPoints) {
  // --- 小 polygon：全像元 ---
  var smallSamples = predictorStack.sampleRegions({
    collection: smallPolygons,
    properties: SAMPLE_PROPS,
    scale: SCALE,
    tileScale: 16,
    geometries: false
  });

  // --- 大 polygon：先撒点，再只在点上取值 ---
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
// 7. 地图 —— 画 polygon 的工作台
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

Map.addLayer(southAmerica9.style(
  {color: 'ffffff', fillColor: '00000000', width: 2}), {}, '南美九国边界', true);
Map.addLayer(dethierSites, {color: 'ffcc00'}, 'Dethier ASGM 参考点', true);

Map.addLayer(trainPolygons.filter(
  ee.Filter.eq('positive_definition','A_complex')),
  {color: '7cff00'}, '正类 A：整片矿区复合体', true);
Map.addLayer(trainPolygons.filter(
  ee.Filter.eq('label','mine_pure_bare_positive')),
  {color: 'ffea00'}, '正类 B：纯裸矿面', true);
Map.addLayer(trainPolygons.filter(ee.Filter.inList('label',
  ['mine_pure_pond_turbid_positive','mine_pure_pond_dark_positive',
   'mine_pure_positive','mine_pure_wetsediment_positive'])),
  {color: 'ff6d00'}, '正类 B：纯尾矿池 / 湿沉积', true);
Map.addLayer(trainPolygons.filter(
  ee.Filter.eq('label','turbid_braided_river_negative')),
  {color: 'ffb300'}, '负类：浑浊/辫状河 ★', true);
Map.addLayer(trainPolygons.filter(
  ee.Filter.eq('label','urban_bare_negative')),
  {color: '00e5ff'}, '负类：城市/裸地 ★', true);
Map.addLayer(trainPolygons.filter(
  ee.Filter.eq('label','river_negative')),
  {color: '2979ff'}, '负类：清澈河流 ★', true);
Map.addLayer(trainPolygons.filter(ee.Filter.inList('label',
  ['agriculture_negative','forest_negative','grassland_negative',
   'agriculture_within_vegetation_negative',
   'agriculture_shoreline_negative'])),
  {color: '9e9e9e'}, '负类：其余五类', false);
Map.addLayer(rejectedPolygons, {color: 'ff0000'}, '❌ 画错国家', true);


// =====================================================================
// 8. 诊断 —— 纯矢量，不采样，不花算力
// =====================================================================
print('底图模式:', basemapMode);
print('=== GEE 脚本 1（v8）：训练侧 · 只导 AlphaEarth ===');
print('已读到的 Import 数:', LABEL_SPECS.length);
print('--- polygon ---');
print('画的 polygon 总数:', allDrawn.size());
print('进入训练的（四国内）:', trainPolygons.size());
print('❌ 被剔除的（画错国家）:', rejectedPolygons.size());
print('独立 site 数:', trainPolygons.distinct(['site_id']).size());
print('按类别的 polygon 数:', trainPolygons.aggregate_histogram('label'));
print('小 polygon（≤' + SMALL_POLYGON_HA + ' ha，全像元取）:', smallPolygons.size());
print('大 polygon（撒点取）:', largePolygons.size());
print('--- 导出规模 ---');
print('特征:', 'AlphaEarth ' + ALPHA_BANDS.length + ' 维'
  + (ADD_FREE_EXTRAS ? ' + 高程/坡度/JRC 水体' : '（不含 Sentinel-2）'));
print('★ FAST 预估行数 ≈',
  largePolygons.size().multiply(POINTS_PER_POLYGON_FAST)
    .add(smallPolygons.aggregate_sum('polygon_area_ha').multiply(100).toInt()));
print('导出方式:', SPLIT_EXPORT_BY_COUNTRY
  ? '按国家拆成 5 个任务（推荐）' : '单个任务');
print('★ FULL 预估行数 ≈',
  largePolygons.size().multiply(POINTS_PER_POLYGON_FULL)
    .add(smallPolygons.aggregate_sum('polygon_area_ha').multiply(100).toInt()));


// =====================================================================
// 9. 导出
// =====================================================================
var selectors = LABEL_PROPERTIES
  .concat(['used_inset_geometry'])
  .concat(['longitude','latitude'])      // 现在来自波段，不是几何
  .concat(ALPHA_BANDS).concat(EXTRA_NAMES);

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
    // 每国一个任务，单次返回值远低于上限。先只跑 fast 那五个。
    TRAIN_COUNTRY_ISO3.forEach(function(iso) {
      exportOne(samplesFast.filter(ee.Filter.eq('country_iso3', iso)),
                'fast_' + iso);
    });
    TRAIN_COUNTRY_ISO3.forEach(function(iso) {
      exportOne(samplesFull.filter(ee.Filter.eq('country_iso3', iso)),
                'full_' + iso);
    });
  } else {
    exportOne(samplesFast, 'fast');
    exportOne(samplesFull, 'full');
  }

  Export.table.toDrive({
    collection: trainPolygons,
    description: EXPORT_PREFIX + '_polygons',
    fileNamePrefix: EXPORT_PREFIX + '_polygons',
    fileFormat: 'GeoJSON'
  });
}
