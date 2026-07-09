// onnxruntime-node's postinstall (a transitive dep of fastembed) downloads the
// Linux/x64 CUDA execution-provider binaries from GitHub unless told to skip.
// Foreman embeds on CPU only, so that download is pure cost: it breaks
// `pnpm install` on offline or firewalled hosts, and hard-errors on CUDA 11
// hosts ("CUDA 11 binaries are not supported by this script yet").
//
// The package reads ONNXRUNTIME_NODE_INSTALL_CUDA, or the npm_config_ form of
// its --onnxruntime-node-install-cuda flag. pnpm 11 does not forward custom
// .npmrc keys to dependency lifecycle scripts — it passes only
// npm_config_node_gyp and npm_config_user_agent — so an .npmrc entry would
// silently do nothing. This hook sets the variable those scripts do inherit.
//
// `??=` leaves an explicit opt-in working: export ONNXRUNTIME_NODE_INSTALL_CUDA
// yourself to pull the CUDA providers.
process.env.ONNXRUNTIME_NODE_INSTALL_CUDA ??= "skip";

module.exports = {};
