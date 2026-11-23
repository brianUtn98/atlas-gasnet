# E3 Colab reproduction and report evidence

The previous [academic report](https://docs.google.com/document/d/1tAOMNtlgHcl-VK6dhpKRzoRF42yZw1_ZOODD1IDrQbA)
uses a learning curve, train/validation metrics, contract/function breakdowns,
identified transaction examples, separate temporal/USDT results and retained
weights outside the temporary Colab runtime. The document is unchanged pending
the professor's instructions.

The separate [evidence notebook](../notebooks/atlas_gasnet_e3_evidence_colab.ipynb)
repeats the fixed two-candidate E3 protocol on full data. Its
[saved Colab execution](https://colab.research.google.com/drive/1KawDL44c8MWIt9HdeMObTE2OTJ_ZBaOR)
is distinct from the [retained local run](../results/e3-2026-11-23/README.md).
This is reproduction on previously evaluated data, not an independent new test.

## Completed evidence

The full Colab run completed on 2026-11-23. Its training cell took 666.37 seconds
on CPU. MLP stopped after 84 epochs and restored epoch 59; symbolic candidate 0
was selected by validation MAE. The complete model/prediction archive, executed
notebook, original PNG figures, exact JSON metrics and seven genuine screenshots
are retained in [the Colab evidence directory](../results/e3-colab-2026-11-23/README.md).
The downloaded 29,543,440-byte archive matches Colab's SHA-256:
`4d12cadde7b8d7c1564de305ea8ecae216a98b2b4b685be5fb6fa292cd61d6ac`.

The unchanged original E2 model was also evaluated on the exact same E3 rows:

| Estimator | Validation MAE (gas) | Temporal MAE (gas) | USDT MAE (gas) |
| --- | ---: | ---: | ---: |
| Retained E2 MLP | 2,069.84 | 2,449.92 | 3,341.20 |
| E3 MLP in Colab | 1,636.68 | 1,879.43 | 7,152.09 |
| E3 symbolic | 4,997.94 | 5,249.89 | 3,360.01 |
| E3 selector median | 7,583.94 | 7,555.65 | 8,997.55 |

E3 MLP improved temporal performance against the fixed E2 reference, while the
E2 model retained the lowest USDT errors. Within the three E3 estimators,
symbolic had the lowest USDT MAE/RMSE. This distinguishes the E3 model-family
comparison from the broader E2/E3 comparison; more data did not improve every
reported condition. The reference comparison performs no fitting or reselection.

The Linux/Python 3.13 Colab MLP differs numerically from the Windows/Python 3.12
local run, including its selected epoch. Keep both runs labelled by environment;
do not combine their scores or choose a run using final-test performance.
Same-runtime evaluation/reload checks passed in Colab. Download integrity and
cross-platform inference checks are recorded in the retained summary.

## Execution

- Pin training code to `28daec0f22501d1bd4c0ed3f84c243fdb2dbc4d3`.
- Use CPU, seed 42, one thread/worker and the existing two symbolic candidates.
- Supply `e3-inputs.zip` through Colab's Files panel before running preparation.
  The local archive is under `models/e3-colab/`, outside version control.
- Archive SHA-256: `51e64ad07fa7d77b0562de436d42eeaa559ab2e6dd20796c988a27cc8e007f32`.
- Verify the four original manifests and their listed Parquet files; prepare
  155,435 / 39,111 / 59,504 / 145,124 rows with 36 train-fitted features.
- Fit and select on train/validation, record a new reproduction freeze, then
  evaluate both final partitions without further tuning.
- Verify evaluation and portable reload, then retain the executed notebook,
  model archive, original figures and genuine browser screenshots.

Rich output frames can fail to load in some browser sessions. Use the Files
panel to upload inputs and inspect generated figures, and the notebook's
plain-text evidence cells for legible metric screenshots. Never substitute
local results while labelling an image as a Colab execution.

## Scope compared with the previous report's plan

The report's prospective section is broader than the completed fixed E3 run:

| Planned condition | Current status |
| --- | --- |
| Retained original E2 MLP | Available, unchanged |
| Symbolic model fitted on E2 inputs | Not executed |
| MLP fitted on enlarged E3 inputs | Completed locally and reproduced in Colab |
| Symbolic model fitted on identical E3 inputs | Completed locally and reproduced in Colab |
| Original E2 MLP scored on the same new E3 rows | Completed in Colab; unchanged retained E2 model |
| Up to eight symbolic configurations | Only two predefined candidates executed |
| Five-seed sensitivity study | Not executed; current run uses seed 42 |

The reproduction does not claim the remaining conditions were run.
If expanding model development after consulting E3 final errors, reserve a new
unconsulted holdout or explicitly label the additional analysis exploratory.
Do not present E2/E3 scores on different rows as a controlled data-volume effect.

## Useful evidence views

1. Verified row counts, block bounds, code revision and fixed configurations.
2. Actual MLP learning curve and selected epoch from Colab.
3. Symbolic evolution, validation candidate errors and selected tree complexity.
4. Validation and separate temporal/USDT comparison tables.
5. Contract/function support and error breakdowns; identified validation cases.
6. Evaluation verification, unchanged frozen hashes, ZIP export and reload parity.

Screenshots document the user interface. Original figure PNGs and machine-readable
metrics remain the evidence for exact numerical reporting. Add figure captions
and extend the academic report only after the professor's guidance is supplied.
