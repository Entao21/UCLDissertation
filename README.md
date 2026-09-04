# UCL Dissertation: Alluvial Gold-Mine Detection with AlphaEarth

Code and supporting material for:

> **Limited labels, unseen continents: A low-cost embedding workflow for
> cross-national alluvial gold-mine detection and downstream river monitoring**
>
> Entao Wang, MSc dissertation, Centre for Advanced Spatial Analysis,
> University College London, 2026.

The submitted dissertation is available at
[`paper/Entao_Wang_UCL_Dissertation_2026.pdf`](paper/Entao_Wang_UCL_Dissertation_2026.pdf).

## Research Scope

The repository contains two linked analyses:

1. **Alluvial-mine classification.** Logistic regression, random forest and
   XGBoost are evaluated using 64-dimensional annual AlphaEarth embeddings.
   The main classifier is trained in Brazil, Colombia, Ecuador, Guyana and
   Peru, then evaluated without retraining in four held-out South American
   countries and three countries on other continents.
2. **Downstream river-change analysis.** Within a bounded Tapajos river system,
   signed 2019-2024 AlphaEarth change is tested for incremental predictive value
   for upstream mining growth. Catchment groups are held out during validation.

This work evaluates labelled locations and sampled river reaches. It does not
claim to produce a complete pixel-level continental mine map, and the downstream
analysis demonstrates predictive association rather than causal pollution.

## Repository Layout

```text
UCLDissertation/
|-- paper/                 Final submitted dissertation
|-- notebooks/             Executed Colab analyses and embedded results
|-- gee/classification/    Training and geographically held-out exports
|-- gee/downstream/        Tapajos topology and AlphaEarth station exports
|-- gee/figures/           Study-area figure preparation
|-- data/reference/        Small reference files that can be redistributed
|-- data/README.md         Data sources, expected exports and exclusions
|-- docs/                  Reproduction and labelling documentation
|-- figures/               Dissertation workflow and conceptual figures
|-- scripts/               Figure-generation source
|-- requirements.txt       Python dependencies for local execution
`-- CITATION.cff           Citation metadata
```

## Quick Start

The notebooks were executed in Google Colab and retain their final outputs.
To reproduce them from source data:

1. Read [`docs/reproducibility.md`](docs/reproducibility.md) and configure the
   user-specific Earth Engine asset paths near the top of each GEE script.
2. Run the classification exports in order: `GEE_1_TRAIN.js`, then
   `GEE_2_HELD_OUT_TEST.js`.
3. Place the resulting country CSVs in a Google Drive `dissertation` folder and
   run [`01_classification_and_transfer.ipynb`](notebooks/01_classification_and_transfer.ipynb).
4. Run `GEE_6_BASIN_IMPACT.js` for the basin table and for AlphaEarth station
   means in both 2019 and 2024. Place the exports and the AMW GeoTIFF in Drive,
   then run [`02_downstream_river_change.ipynb`](notebooks/02_downstream_river_change.ipynb).

For local execution, create an environment and install the dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

The Colab mount cells can then be skipped and `SEARCH_DIRS` changed to local
paths. Random seeds and country allocation are fixed in the notebooks.

## Data Availability

Large source rasters and generated CSV exports are intentionally excluded from
Git. They would make the repository unnecessarily large and some are governed
by third-party terms. Exact filenames, source links and generation steps are in
[`data/README.md`](data/README.md).

Google Earth Engine Geometry Imports are stored separately from script text by
the Code Editor. Consequently, the `.js` files document the processing logic,
but manually digitised polygons must be imported under the variable names used
in each script before rerunning an export.

## Reproducibility Notes

- Classification sampling uses the same AlphaEarth bands and per-polygon
  procedure in training and held-out locations.
- The notebook applies a maximum of 300 retained observations per polygon,
  class weighting, grouped spatial validation and a 10 km exclusion zone.
- The transfer threshold is selected only from spatially buffered training
  folds and is not re-tuned in held-out countries.
- The downstream notebook holds out catchment groups and reports incremental
  performance over contextual baselines.
- Generated maps should be treated as screening evidence, not as legal
  determinations of mining status.

No open-source licence has yet been assigned. The dissertation and third-party
data remain subject to their respective copyright and data-use terms.
