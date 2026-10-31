import fs from "node:fs";
import path from "node:path";

/** Opt-in is a fixture boundary, not authentication against the OS account owner. */
export const authorizeDisposableRatchetProfile = (options: {
  development: boolean; requested: boolean; root?: string; temporaryDirectory: string;
}) => {
  if (!options.requested) {
    if (options.root && fs.existsSync(path.join(options.root, "phase2i-disposable.json"))) {
      throw new Error("EXPERIMENT_PROFILE_REQUIRES_OPT_IN");
    }

    return false;
  }

  if (!options.development || !options.root) throw new Error("UNIFIED_PROFILE_BLOCKED");
  const root = path.resolve(options.root);
  const temporary = fs.realpathSync(options.temporaryDirectory);

  if (path.dirname(root).toLowerCase() !== temporary.toLowerCase() ||
      !path.basename(root).startsWith("nkc-phase2i-")) throw new Error("UNIFIED_PROFILE_BLOCKED");

  if (fs.existsSync(root) && (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root)) {
    throw new Error("UNIFIED_PROFILE_BLOCKED");
  }

  const marker = path.join(root, "phase2i-disposable.json");
  const expected = JSON.stringify({ version: 1, root, experiment: "unified-text" });

  if (fs.existsSync(marker)) {
    if (!fs.lstatSync(marker).isFile() || fs.lstatSync(marker).isSymbolicLink() ||
        fs.readFileSync(marker, "utf8") !== expected) throw new Error("UNIFIED_PROFILE_BLOCKED");

    return true;
  }

  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error("UNIFIED_PROFILE_NOT_FRESH");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(marker, expected, { flag: "wx", mode: 0o600 });

  return true;
};

/** Additional Phase 2Q opt-in may only start from a blank Phase 2I disposable root. */
export const authorizeDisposableRecoveryProfile = (options: {
  requested: boolean; unifiedAuthorized: boolean; root?: string; temporaryDirectory: string;
}) => {
  if (!options.root) {
    if (options.requested) throw new Error("RECOVERY_PROFILE_BLOCKED");

    return false;
  }

  const marker = path.join(options.root, "phase2q-disposable.json");

  if (!options.requested) {
    if (fs.existsSync(marker)) throw new Error("RECOVERY_PROFILE_REQUIRES_OPT_IN");

    return false;
  }

  if (!options.unifiedAuthorized || !path.basename(options.root).startsWith("nkc-phase2i-phase2q-") ||
      path.dirname(path.resolve(options.root)).toLowerCase() !== fs.realpathSync(options.temporaryDirectory).toLowerCase()) {
    throw new Error("RECOVERY_PROFILE_BLOCKED");
  }

  const expected = JSON.stringify({ version: 1, root: path.resolve(options.root), experiment: "recovery-v2" });

  if (fs.existsSync(marker)) {
    if (!fs.lstatSync(marker).isFile() || fs.lstatSync(marker).isSymbolicLink() || fs.readFileSync(marker, "utf8") !== expected) {
      throw new Error("RECOVERY_PROFILE_BLOCKED");
    }

    return true;
  }

  if (fs.readdirSync(options.root).some(name => name !== "phase2i-disposable.json")) throw new Error("RECOVERY_PROFILE_NOT_FRESH");
  fs.writeFileSync(marker, expected, { flag: "wx", mode: 0o600 });

  return true;
};

/** Isolated native CAS trial; never attaches ownership metadata to an occupied profile. */
export const authorizeDisposableNativeOwnerProfile = (options: {
  development: boolean; requested: boolean; unifiedAuthorized?: boolean; root?: string; temporaryDirectory: string;
}) => {
  if (!options.root) {
    if (options.requested) throw new Error("NATIVE_OWNER_PROFILE_BLOCKED");

    return false;
  }

  const root = path.resolve(options.root);
  const marker = path.join(root, "phase10e-disposable.json");

  if (!options.requested) {
    if (fs.existsSync(marker)) throw new Error("NATIVE_OWNER_PROFILE_REQUIRES_OPT_IN");

    return false;
  }

  const combined = path.basename(root).startsWith("nkc-phase2i-phase10e-");

  if (!options.development || path.dirname(root).toLowerCase() !== fs.realpathSync(options.temporaryDirectory).toLowerCase() ||
      (!path.basename(root).startsWith("nkc-phase10e-") && !combined) ||
      (combined && !options.unifiedAuthorized)) throw new Error("NATIVE_OWNER_PROFILE_BLOCKED");

  if (fs.existsSync(root) && (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root)) {
    throw new Error("NATIVE_OWNER_PROFILE_BLOCKED");
  }

  const expected = JSON.stringify({ version: 1, root, experiment: "ordinary-native-cas" });

  if (fs.existsSync(marker)) {
    if (!fs.lstatSync(marker).isFile() || fs.lstatSync(marker).isSymbolicLink() ||
        fs.readFileSync(marker, "utf8") !== expected) throw new Error("NATIVE_OWNER_PROFILE_BLOCKED");

    return true;
  }

  const contents = fs.existsSync(root) ? fs.readdirSync(root) : [];

  if (contents.some(name => !(combined && name === "phase2i-disposable.json"))) throw new Error("NATIVE_OWNER_PROFILE_NOT_FRESH");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(marker, expected, { flag: "wx", mode: 0o600 });

  return true;
};
