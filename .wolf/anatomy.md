# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-07-28T14:03:13.175Z
> Files: 141 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `.dockerignore` — Docker ignore rules (~12 tok)
- `.DS_Store` (~2729 tok)
- `.gitignore` — Git ignore rules (~16 tok)
- `.nvmrc` (~3 tok)
- `admincli.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~3694 tok)
- `adminweb.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~16940 tok)
- `check-tapis-jobs.sh` — Script to check Tapis jobs (~192 tok)
- `CLAUDE.md` — OpenWolf (~1966 tok)
- `clusterodm-config.json` (~286 tok)
- `clusterodm-nginx.conf` — Declares location (~983 tok)
- `clusterodm-tapis.log` (~315 tok)
- `clusterodm-tapis.pid` (~2 tok)
- `ClusterODM.log` — Declares on (~5473 tok)
- `CONDUCT.md` (~18 tok)
- `config-default.json` (~304 tok)
- `config.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~2422 tok)
- `CONTRIBUTING.md` (~19 tok)
- `debug-asr.js` — Debug script to check ASR provider status (~1241 tok)
- `debug-tapis.sh` — Tapis debugging script - test data transfer and job submission with curl (~3118 tok)
- `deregister-node.js` — Node De-Registration Client for ClusterODM-Tapis (~1356 tok)
- `deregister-node.sh` — ClusterODM Node De-Registration Shell Script (~118 tok)
- `docker-compose.yml` — Docker Compose services (~148 tok)
- `Dockerfile` — Docker container definition (~294 tok)
- `Dockerfile.local-dev` (~145 tok)
- `index.js` — nodeodm-proxy - A reverse proxy, load balancer and task tracker for NodeODM (~1099 tok)
- `init.md` — ClusterODM-Tapis Initialization Guide (~1304 tok)
- `ISSUE_TEMPLATE.md` (~232 tok)
- `job_definition.json` (~257 tok)
- `letsencrypt-autogen.sh` (~278 tok)
- `LICENSE` — Project license (~9207 tok)
- `monitor-tapis-job.sh` — Monitor Tapis job on LS6 - track from submission to completion (~1268 tok)
- `odm_job.json` (~239 tok)
- `package_info.js` — Declares fs (~32 tok)
- `package-lock.json` — npm lock file (~115942 tok)
- `package.json` — Node.js package manifest (~340 tok)
- `README.md` — Project documentation (~2970 tok)
- `register-node.js` — Node Auto-Registration Client for ClusterODM-Tapis (~4299 tok)
- `register-node.sh` — ClusterODM Node Auto-Registration Shell Script (~4520 tok)
- `restart.sh` — Restart helper for ClusterODM-Tapis running from this workspace. (~703 tok)
- `run-clusterodm-tapis.sh` — Complete ClusterODM + Tapis Integration Script (~2031 tok)
- `sample.slurm` — source .bashrc (~95 tok)
- `simple-tapis-test.sh` — Simple Tapis test using SCRATCH filesystem on ls6 (~1848 tok)
- `submit-job.sh` — ClusterODM Tapis Job Submission Script (~773 tok)
- `tapis-config-sample.json` (~519 tok)
- `tapis-config.json` (~630 tok)
- `test-direct-tapis.sh` — Direct Tapis job submission test - confirm output stays on LS6 (~996 tok)
- `test-upload.html` — ClusterODM Image Upload Test (~659 tok)
- `test-webhook.js` — Simple test script for the webhook registration endpoint (~1756 tok)
- `token_test.response` (~859 tok)
- `verify-tapis-setup.js` — Script to verify Tapis setup for ClusterODM (~1465 tok)
- `winbundle.js` — '], { stdio: "pipe"}).status; (~836 tok)

## .claude/

- `settings.json` (~441 tok)
- `settings.local.json` (~42 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## .github/workflows/

- `publish-docker.yml` — CI: Build and Publish Docker Image (~364 tok)
- `publish-windows.yml` — name: Publish Windows Bundle (~266 tok)

## contrib/kubernetes/

- `k8clusternodeodm.yml` — K8s Deployment: nodeodm-deployment (~436 tok)
- `README.md` — Project documentation (~580 tok)

## data/

- `.gitignore` — Git ignore rules (~1 tok)
- `nodes.json` (~1 tok)
- `routes.json` (~1 tok)

## docker/data/

- `.gitignore` — Git ignore rules (~1 tok)

## docs/

- `aws.md` — Provider Configuration for Amazon Web Services (~2399 tok)
- `digitalocean.md` — Provider Configuration for DigitalOcean (~1765 tok)
- `hetzner.md` — Installing the Hetzner Driver (~1763 tok)
- `PATH_MAPPING.md` — ClusterODM Path Mapping (node_shared_path_mappings) (~612 tok)
- `scaleway.md` — Installing the Scaleway Driver (~1663 tok)
- `tapis.md` — Tapis Integration for ClusterODM (~1822 tok)
- `webhook-registration.md` — Automatic Node Registration via Webhook (~4057 tok)

## examples/

- `slurm-nodeodm-worker.sh` — SBATCH --job-name=nodeodm-worker (~2911 tok)

## letsencrypt/

- `.gitignore` — Git ignore rules (~1 tok)

## libs/

- `.DS_Store` (~1639 tok)
- `asrProvider.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~2121 tok)
- `cloudProvider.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~396 tok)
- `concurrencyMonitor.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~515 tok)
- `floodMonitor.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~672 tok)
- `logger.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~1022 tok)
- `netutils.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~885 tok)
- `nodes.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~3036 tok)
- `odmOptions.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~2282 tok)
- `proxy.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~19749 tok)
- `routetable.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~1854 tok)
- `S3.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~607 tok)
- `splitLogger.js` — fs: append (~244 tok)
- `statusCodes.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~259 tok)
- `tapisTaskOptions.js` — Declares TAPIS_OPTION_NAMES (~402 tok)
- `taskNew.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~24861 tok)
- `tasktable.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~1024 tok)
- `utils.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~2854 tok)

## libs/asr-providers/

- `aws.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~2532 tok)
- `digitalocean.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~2617 tok)
- `hetzner.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~2604 tok)
- `scaleway.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~1745 tok)
- `tapis.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~18355 tok)

## libs/classes/

- `AbstractASRProvider.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~2109 tok)
- `AbstractCloudProvider.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~716 tok)
- `DockerMachine.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~1322 tok)
- `Node.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~3066 tok)
- `TapisNode.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~6521 tok)
- `ValueCache.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~595 tok)

## libs/cloud-providers/

- `LightningCloudProvider.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~1429 tok)
- `LightningDevCloudProvider.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~423 tok)
- `LocalCloudProvider.js` — ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM (~446 tok)

## public/

- `.DS_Store` (~1640 tok)
- `app.mjs` — API routes: GET (1 endpoints) (~2670 tok)
- `common.fetch.js` — Exports postFetch, patchFetch, deleteFetch (~303 tok)
- `index.html` — ClusterODM (~155 tok)
- `theme.css` — Styles: 7 rules (~177 tok)

## public/component/

- `addInstanceButton.mjs` — Exports AddInstanceButton (~416 tok)
- `dialog.mjs` — * @param {Object} param (~703 tok)
- `header.mjs` — Exports Header (~293 tok)
- `loginForm.mjs` — Exports LoginForm (~1238 tok)
- `nodeList.mjs` — Exports NodeList (~2006 tok)
- `refreshButton.mjs` — Exports RefreshButton (~134 tok)
- `taskList.mjs` — Exports TaskList (~3076 tok)

## public/lib/

- `bootstrap-icons.css` — Styles: 242 rules (~18771 tok)
- `bootstrap-icons.json` (~9995 tok)
- `bootstrap.min.css.map` (~114526 tok)
- `hooks.module.js` — m: l, p, y + 13 more (~758 tok)
- `hooks.module.js.map` — Exports useState (~4007 tok)
- `htm.module.js` (~345 tok)
- `preact.html.mjs` (~56 tok)
- `preact.module.js` — c: s, a, v + 25 more (~2887 tok)
- `preact.module.js.map` — \n * The `option` object can potentially contain callback functions\n * that are called during various stages of our renderer. This is the\n * foun... (~18501 tok)
- `README.md` — Project documentation (~87 tok)

## services/

- `clusterodm.service` (~69 tok)

## test/

- `test-config-node-shared-path.js` — Declares assert (~164 tok)
- `test-parse-node-response.js` — Declares assert (~225 tok)
- `test-tapis-active-jobs.js` — Declares assert (~685 tok)
- `test-tapis-checkpoint-resume.js` — assert: makeToken (~512 tok)
- `test-tapis-task-options.js` — Declares assert (~1318 tok)
- `test-translate-path-edges.js` — assert: setMapping (~562 tok)
- `test-translate-path.js` — assert: setMapping (~615 tok)

## testData/

- `.DS_Store` (~1640 tok)
- `benchmark.txt` (~142 tok)
- `cameras.json` (~135 tok)
- `images.json` (~5736 tok)
- `img_list.txt` (~150 tok)
- `log.json` — Declares explicitly (~15081 tok)
- `options.json` (~602 tok)

## tmp/

- `.gitignore` — Git ignore rules (~1 tok)
