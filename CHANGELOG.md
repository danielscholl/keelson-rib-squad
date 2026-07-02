# Changelog

## [0.8.0](https://github.com/danielscholl/keelson-rib-squad/compare/v0.7.1...v0.8.0) (2026-07-02)


### Added

* **boards:** recompose the Run-loop board around rounds, minds, and expandable detail ([#117](https://github.com/danielscholl/keelson-rib-squad/issues/117)) ([e517f37](https://github.com/danielscholl/keelson-rib-squad/commit/e517f37991c2a864b74c9a1e3e9802acbae6a7c5))
* **coordinator:** capture tool traces, usage, and timing from turns ([#115](https://github.com/danielscholl/keelson-rib-squad/issues/115)) ([cb5503a](https://github.com/danielscholl/keelson-rib-squad/commit/cb5503a2a65d6e61513a373b9856e7cc037d8819))


### Fixed

* **boards:** harden loadRun shape guard, keep identifiers in stripMd, catch in view-run ([#118](https://github.com/danielscholl/keelson-rib-squad/issues/118)) ([dddc5a4](https://github.com/danielscholl/keelson-rib-squad/commit/dddc5a4ac21a3a3137b045327d7b850cb858408c))

## [0.7.1](https://github.com/danielscholl/keelson-rib-squad/compare/v0.7.0...v0.7.1) (2026-07-02)


### Documentation

* fill out the Squad rib Starlight docs ([#104](https://github.com/danielscholl/keelson-rib-squad/issues/104)) ([4e18599](https://github.com/danielscholl/keelson-rib-squad/commit/4e185998ecb17cf0cf375cedac07ae7424804d6e))

## [0.7.0](https://github.com/danielscholl/keelson-rib-squad/compare/v0.6.0...v0.7.0) (2026-07-01)


### Added

* add operator-triggered draft change-request pipeline (GitHub PR / GitLab MR) ([#96](https://github.com/danielscholl/keelson-rib-squad/issues/96)) ([a8c109a](https://github.com/danielscholl/keelson-rib-squad/commit/a8c109aa1647334c3af41a33276df1cbb152a0bc))
* add read-only squad_view_diff tool ([#99](https://github.com/danielscholl/keelson-rib-squad/issues/99)) ([32898b2](https://github.com/danielscholl/keelson-rib-squad/commit/32898b26f3d838d55bc77abd9b3c1f917d598625))
* add round-budget indicator to coordinator run-loop board ([#93](https://github.com/danielscholl/keelson-rib-squad/issues/93)) ([a98e2f7](https://github.com/danielscholl/keelson-rib-squad/commit/a98e2f7e3d0176aa6caf9c7bc6daedc9f699138b))
* attribute reviewer verdicts with a 'reviewed' provenance verb ([#91](https://github.com/danielscholl/keelson-rib-squad/issues/91)) ([e5e5190](https://github.com/danielscholl/keelson-rib-squad/commit/e5e5190d1ceaabd4eac8c248deb86f80e459286f))
* capture per-check verification breakdown at done-gate ([#90](https://github.com/danielscholl/keelson-rib-squad/issues/90)) ([5ebc99c](https://github.com/danielscholl/keelson-rib-squad/commit/5ebc99c9332b358d7deb7498bfacd56d571a08bf))
* **coordinator:** ground prompt with bound project details ([#103](https://github.com/danielscholl/keelson-rib-squad/issues/103)) ([582b229](https://github.com/danielscholl/keelson-rib-squad/commit/582b2293814e9cf847dcc04dc41014079588e056))
* **coordinator:** incomplete-commit gate at the done-gate ([#102](https://github.com/danielscholl/keelson-rib-squad/issues/102)) ([c8a58a4](https://github.com/danielscholl/keelson-rib-squad/commit/c8a58a482d50f43b4347e35f4c7b776982664d71))
* **review:** add repo-agnostic consistency + test-adequacy lenses to the adversarial review ([#94](https://github.com/danielscholl/keelson-rib-squad/issues/94)) ([b297292](https://github.com/danielscholl/keelson-rib-squad/commit/b2972929bf11be78e3fa5d67480949f88ab2bb28))
* **surface:** redesign the Squad surface into a workflows-shaped console ([#87](https://github.com/danielscholl/keelson-rib-squad/issues/87)) ([b5e80d3](https://github.com/danielscholl/keelson-rib-squad/commit/b5e80d3a9a7de75da4f43d4d772555e60968c3dc))

## [0.6.0](https://github.com/danielscholl/keelson-rib-squad/compare/v0.5.0...v0.6.0) (2026-07-01)


### Added

* **cast:** refine no-selection error for cast action ([#85](https://github.com/danielscholl/keelson-rib-squad/issues/85)) ([1e81c92](https://github.com/danielscholl/keelson-rib-squad/commit/1e81c92acfc94d05b28bb318b28a3f8e5a55f62a))
* **dispatch:** reserve diff budgets to keep untracked new-file diffs visible ([#82](https://github.com/danielscholl/keelson-rib-squad/issues/82)) ([416e00c](https://github.com/danielscholl/keelson-rib-squad/commit/416e00cf80909f405e304841f15fbc4b2a3d296e))
* **runs:** archive closed run ledgers and add a squad_runs tool ([#86](https://github.com/danielscholl/keelson-rib-squad/issues/86)) ([8bf081f](https://github.com/danielscholl/keelson-rib-squad/commit/8bf081fc10723da4ec94eb1963b8efdbe46cd4fb))


### Fixed

* **forbidden:** refine isForbiddenGitCommand subshell/grouping handling ([#83](https://github.com/danielscholl/keelson-rib-squad/issues/83)) ([63291d5](https://github.com/danielscholl/keelson-rib-squad/commit/63291d5e49b3f0310c82ed1e199ae958aa854d29))

## [0.5.0](https://github.com/danielscholl/keelson-rib-squad/compare/v0.4.0...v0.5.0) (2026-06-30)


### Added

* **boards:** make the coordinator run loop observable ([#68](https://github.com/danielscholl/keelson-rib-squad/issues/68)) ([5650261](https://github.com/danielscholl/keelson-rib-squad/commit/56502611924583ae7bf97ca817b2a741d197d34d))
* **change-quality:** deterministic regression guard at done-gate ([#62](https://github.com/danielscholl/keelson-rib-squad/issues/62)) ([69d816a](https://github.com/danielscholl/keelson-rib-squad/commit/69d816a518b91d7670ad19e0cbfe16e035c3e5cb)), closes [#52](https://github.com/danielscholl/keelson-rib-squad/issues/52)
* **coordinator:** show a live in-flight card for the current turn ([#76](https://github.com/danielscholl/keelson-rib-squad/issues/76)) ([bc17270](https://github.com/danielscholl/keelson-rib-squad/commit/bc17270293463b990073ca38678427f463c185a7))
* **coordinator:** stream the run-loop board after each ledger persist ([#75](https://github.com/danielscholl/keelson-rib-squad/issues/75)) ([dd85637](https://github.com/danielscholl/keelson-rib-squad/commit/dd856375053ba4059f6776b46b5dcc2b1a27617b))
* **squad:** per-project squads with a project picker ([#79](https://github.com/danielscholl/keelson-rib-squad/issues/79)) ([285d6e9](https://github.com/danielscholl/keelson-rib-squad/commit/285d6e9452d2154fc75774387bb0abbbdc1a130d))


### Fixed

* **loop:** treat a repeated-identical outcome as a stall ([#65](https://github.com/danielscholl/keelson-rib-squad/issues/65)) ([0169254](https://github.com/danielscholl/keelson-rib-squad/commit/0169254bc55bbe78c0905ea1dd7e2460f7edc04c))
* **review:** give the synthesis turn the project-bound read rail ([#66](https://github.com/danielscholl/keelson-rib-squad/issues/66)) ([5ee7c3a](https://github.com/danielscholl/keelson-rib-squad/commit/5ee7c3aa45fc7d76f6db94e31deaa16db51a22d5))
* **review:** ground BLOCK verdicts; recognize green-but-blocked runs ([#64](https://github.com/danielscholl/keelson-rib-squad/issues/64)) ([6fbb9d1](https://github.com/danielscholl/keelson-rib-squad/commit/6fbb9d1b6db50ee4a8ce2c26fa74d83979b4bb2f))

## [0.4.0](https://github.com/danielscholl/keelson-rib-squad/compare/v0.3.0...v0.4.0) (2026-06-29)


### Added

* **coordinator:** support optional manager provider/model pins ([#61](https://github.com/danielscholl/keelson-rib-squad/issues/61)) ([e4d2114](https://github.com/danielscholl/keelson-rib-squad/commit/e4d21144db33980e5f69de3c8eb1a354cf979cc5))
* expose maxStall and maxResets caps on squad_coordinate ([#47](https://github.com/danielscholl/keelson-rib-squad/issues/47)) ([88fbbe0](https://github.com/danielscholl/keelson-rib-squad/commit/88fbbe0b1cd1222a058c033914e5ded397d3f66f))
* gate 'done' on a deterministic verification check ([#48](https://github.com/danielscholl/keelson-rib-squad/issues/48)) ([#54](https://github.com/danielscholl/keelson-rib-squad/issues/54)) ([7cbd1a3](https://github.com/danielscholl/keelson-rib-squad/commit/7cbd1a30b73d4b6dc7e462856daeecae10149601))
* **review:** add project-bound adversarial review gating ([#60](https://github.com/danielscholl/keelson-rib-squad/issues/60)) ([2d4ec45](https://github.com/danielscholl/keelson-rib-squad/commit/2d4ec45e3c356125f3bc612a3a2f2f8dc889194c))


### Fixed

* **policies:** restrict BLOCK verdict denial to workflow surface ([#58](https://github.com/danielscholl/keelson-rib-squad/issues/58)) ([30d2021](https://github.com/danielscholl/keelson-rib-squad/commit/30d2021cc7a2a095e3d9e6cf1b5e879dedec03e9))

## [0.3.0](https://github.com/danielscholl/keelson-rib-squad/compare/v0.2.0...v0.3.0) (2026-06-29)


### Added

* attribute each work unit to its served provider ([#46](https://github.com/danielscholl/keelson-rib-squad/issues/46)) ([4eb4bf8](https://github.com/danielscholl/keelson-rib-squad/commit/4eb4bf806f10a02cb12b2c0027c015d7ff641b08))
* **cast:** auto-assign provider/model from the available catalog by role ([#43](https://github.com/danielscholl/keelson-rib-squad/issues/43)) ([0c5cf92](https://github.com/danielscholl/keelson-rib-squad/commit/0c5cf9256067e9bfc0f62cdd4253657f51b04581))
* **mixed-provider:** allow provider-only pins, a model needs its provider ([#41](https://github.com/danielscholl/keelson-rib-squad/issues/41)) ([91570db](https://github.com/danielscholl/keelson-rib-squad/commit/91570dbc8620d3b7c78a0830a4da5fc14af2f5f6))


### Fixed

* close correctness gaps found in the audit pass ([#44](https://github.com/danielscholl/keelson-rib-squad/issues/44)) ([a3ea113](https://github.com/danielscholl/keelson-rib-squad/commit/a3ea113f22a76b17766c7c3a7b32bc93228288a1))

## [0.2.0](https://github.com/danielscholl/keelson-rib-squad/compare/v0.1.0...v0.2.0) (2026-06-29)


### Added

* **cast:** add squad casting workflow with repo-scan proposal ([#17](https://github.com/danielscholl/keelson-rib-squad/issues/17)) ([769f448](https://github.com/danielscholl/keelson-rib-squad/commit/769f448b2aad309b121de7b621c126d784b3edf6))
* **casting:** add deterministic themed casting engine and registry ([#18](https://github.com/danielscholl/keelson-rib-squad/issues/18)) ([85ad28a](https://github.com/danielscholl/keelson-rib-squad/commit/85ad28ac9f2949f7cbeb14bfcfe6ba03bcea651b))
* **coord:** add durable squad coordinator and trailing JSON parser ([#22](https://github.com/danielscholl/keelson-rib-squad/issues/22)) ([c0068cf](https://github.com/danielscholl/keelson-rib-squad/commit/c0068cfb68757780bf3d748e968a3686764a5c78))
* **coordination:** enable code-arm turns in coordinator and orchestrator ([#23](https://github.com/danielscholl/keelson-rib-squad/issues/23)) ([db31b2c](https://github.com/danielscholl/keelson-rib-squad/commit/db31b2caa6f36ff07af8768dd0f3f1ff138d2059))
* **coordinator:** add failStuckTasks and failed steps tracking ([#28](https://github.com/danielscholl/keelson-rib-squad/issues/28)) ([38399dc](https://github.com/danielscholl/keelson-rib-squad/commit/38399dc5ac80469321bf4d748d7499e61cae6cfb))
* **coordinator:** add per-member loop-close reflection memory ([#30](https://github.com/danielscholl/keelson-rib-squad/issues/30)) ([439b2c3](https://github.com/danielscholl/keelson-rib-squad/commit/439b2c3a57f7b1db736189ac87bd847031ae73d7))
* **coordinator:** governed-memory loop — recall into a run, reflect on done ([#26](https://github.com/danielscholl/keelson-rib-squad/issues/26)) ([d340490](https://github.com/danielscholl/keelson-rib-squad/commit/d34049006e7061aa0387c0bf76103fbdfbadbd80))
* **coord:** surface team gap recommendations ([#33](https://github.com/danielscholl/keelson-rib-squad/issues/33)) ([14cf118](https://github.com/danielscholl/keelson-rib-squad/commit/14cf11873023a1844fb17e905805dd9db0813240))
* **dispatch:** add squad_dispatch fan-out coordinator ([#11](https://github.com/danielscholl/keelson-rib-squad/issues/11)) ([b8b724e](https://github.com/danielscholl/keelson-rib-squad/commit/b8b724ed5c52c8a8494f0594421b7b2c382cc8c4))
* **dispatch:** enable project-scoped repo reading for dispatch turns ([#32](https://github.com/danielscholl/keelson-rib-squad/issues/32)) ([66cbe6b](https://github.com/danielscholl/keelson-rib-squad/commit/66cbe6b602e892c86772db41c8b85296d39fe954))
* **ledger:** rebuild task ledger on replan and clear abandoned plan ([#29](https://github.com/danielscholl/keelson-rib-squad/issues/29)) ([36f418e](https://github.com/danielscholl/keelson-rib-squad/commit/36f418e35af001fc2de5e98c6dfc03d0cce8111a))
* **memory:** distill a completed run into a durable governed decision ([#15](https://github.com/danielscholl/keelson-rib-squad/issues/15)) ([#34](https://github.com/danielscholl/keelson-rib-squad/issues/34)) ([9aaf69e](https://github.com/danielscholl/keelson-rib-squad/commit/9aaf69e3e941fd9472b2f88d763616bd66707c6a))
* **orchestrator:** add pure orchestrator step logic and dispatch stub ([#21](https://github.com/danielscholl/keelson-rib-squad/issues/21)) ([a9d287e](https://github.com/danielscholl/keelson-rib-squad/commit/a9d287e59633c1d313503dd011647efa514588b2))
* **runloop:** implement coordinator run loop board ([#31](https://github.com/danielscholl/keelson-rib-squad/issues/31)) ([4636f09](https://github.com/danielscholl/keelson-rib-squad/commit/4636f095dcda1bdef1deaacfee8af3aaa6114dec))
* **squad:** add decisions board and memory reflection features ([#13](https://github.com/danielscholl/keelson-rib-squad/issues/13)) ([7f45008](https://github.com/danielscholl/keelson-rib-squad/commit/7f4500851e61e3cd53eb3e803c6f6432920f17aa))
* **squad:** add squad rib with roster board and member persistence ([1700b3c](https://github.com/danielscholl/keelson-rib-squad/commit/1700b3c4f5d0bd8c9e3fb083eeaa6273310ca68c))
* **squad:** introduce confined coding turn with governance ([#19](https://github.com/danielscholl/keelson-rib-squad/issues/19)) ([93bb2c6](https://github.com/danielscholl/keelson-rib-squad/commit/93bb2c62b64a7d42ea10d124260fd5514f091221))
* **squad:** run squad-authored workflows via the runWorkflow seam ([#25](https://github.com/danielscholl/keelson-rib-squad/issues/25)) ([1e034cf](https://github.com/danielscholl/keelson-rib-squad/commit/1e034cf24a2e3c21233a2d684e540e94a0561565))
* **workflow:** add reusable workflow DAG authoring arm ([#24](https://github.com/danielscholl/keelson-rib-squad/issues/24)) ([e7a71e0](https://github.com/danielscholl/keelson-rib-squad/commit/e7a71e0b4472ddec822fdf2f6ec014e85a756741))


### Fixed

* **coordinator:** make recalled memory actually inform the run ([#27](https://github.com/danielscholl/keelson-rib-squad/issues/27)) ([9914395](https://github.com/danielscholl/keelson-rib-squad/commit/99143950ffc1e2e358fbcf6412130ea7d7f55ec0))


### Documentation

* credit upstream Squad project in README and NOTICE ([#35](https://github.com/danielscholl/keelson-rib-squad/issues/35)) ([f7cda14](https://github.com/danielscholl/keelson-rib-squad/commit/f7cda1491697cdf9e6366621e9777416c28b1f77))
* scaffold Astro Starlight site ([#39](https://github.com/danielscholl/keelson-rib-squad/issues/39)) ([cf99763](https://github.com/danielscholl/keelson-rib-squad/commit/cf997631357d7cf3a874607b35804123ac8bdb83))
