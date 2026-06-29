# Changelog

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
