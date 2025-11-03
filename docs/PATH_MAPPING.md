# ClusterODM Path Mapping (node_shared_path_mappings)

This document explains the `node_shared_path_mappings` configuration and how ClusterODM translates shared filesystem paths (sent by WebODM) into node-local paths for NodeODM instances.

Why this exists
- In some deployments WebODM and NodeODM share storage but mount it under different absolute paths on different hosts (for example, `/corral/webodm/media` on the web host and `/corral-repl/.../webodm/media` on compute nodes). To avoid uploading images over HTTP, WebODM can send an `import_path` (a directory path) and ClusterODM will translate it for the target node.

Config location
- Add mappings to `config-default.json` or your `config.json` (the value is read into `config.node_shared_path_mappings`). Example:

```json
"node_shared_path_mappings": {
  "nodeodm-ls6": {
    "/corral/webodm/media": "/corral-repl/tacc/aci/PT2050/projects/PTDATAX-263/webodm/media"
  },
  "*": {
    "/corral/webodm/media": "/corral-repl/tacc/aci/PT2050/projects/PTDATAX-263/webodm/media"
  }
}
```

Lookup rules
1. Exact hostname: `nodeodm-ls6`
2. Short hostname: if the node reports `nodeodm-ls6.example.edu`, we try `nodeodm-ls6`
3. Wildcard `*`: fallback that matches any node

Translation algorithm
- For each mapping entry the key is a source prefix (string). If the incoming `import_path` starts with that prefix, ClusterODM replaces the prefix with the configured destination prefix and normalizes the path. The first match found (based on host lookup order above) is used.

Behavior
- If a translation exists, ClusterODM will POST to the node's `/task/new` endpoint with the `import_path` form field (no files). NodeODM must support `import_path` (NodeODM-side code already supports this pattern in WebODM's wrappers).
- If no mapping exists or forwarding fails, ClusterODM falls back to the existing upload flow (so behavior is backward-compatible).

Testing
- Unit tests for the translation helper are available in `test/test-translate-path.js` and `test/test-translate-path-edges.js`.
- Run them from the `ClusterODM-Tapis` folder:

```bash
cd ClusterODM-Tapis
npm test
```

Notes
- Use the wildcard mapping (`"*"`) for dynamically-created nodes with a uniform mount layout (suitable for your Tapis-based workflow).
- Exact hostname mappings take precedence and let you special-case nodes when needed.
- Be careful with permissions: ensure NodeODM processes can read the translated path.
