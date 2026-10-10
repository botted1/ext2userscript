// The ext2userscript command line (spec §7): convert, download and report.
// Run it with: npm run cli -- <command> <source> [options]
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadEsbuild } from "./convert/esbuild-node.ts";
import { convert, inspect } from "./convert/index.ts";
import { slugify } from "./convert/metadata.ts";
import { formatReport, printable, type Report } from "./convert/report.ts";
import { loadRuntime } from "./convert/runtime-node.ts";
import { parseSource, readArchive, readSource, sourceName, type Source } from "./source.ts";

export const USAGE = `Usage:
  ext2userscript convert <source> [-o out.user.js] [--report report.json] [--locale xx] [--minify] [--ignore-assets glob,...] [--force]
  ext2userscript download <source> [-o file] [--force]
  ext2userscript report <source> [--report report.json] [--locale xx]

<source> is a Chrome Web Store URL or ID, an AMO URL or slug, an Edge Add-ons URL, a .crx/.xpi/.zip URL,
a local archive or a directory. A bare 32-letter ID is looked up on the Chrome Web Store.

--force overwrites output files that already exist.
Exit codes: 0 done; 1 error; 2 converted or reported, but the verdict is "unlikely".`;

type Output = { write(text: string): unknown };

export async function main(argv: readonly string[], out: Output = process.stdout, err: Output = process.stderr): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        output: { type: "string", short: "o" },
        report: { type: "string" },
        locale: { type: "string" },
        minify: { type: "boolean" },
        "ignore-assets": { type: "string" },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    err.write(`ext2userscript: ${(error as Error).message}\n\n${USAGE}\n`);
    return 1;
  }
  const { positionals, values } = parsed;
  const [command, input, ...extra] = positionals;
  if (values.help) {
    out.write(`${USAGE}\n`);
    return 0;
  }
  if (!command || !["convert", "download", "report"].includes(command) || !input || extra.length > 0) {
    err.write(`${USAGE}\n`);
    return 1;
  }

  try {
    const source = await parseSource(input);
    // A mistyped folder name can read as an AMO slug, so say so before anything is fetched.
    const remote = remoteName(source);
    if (remote) err.write(`Downloading ${remote}\n`);
    const write = (path: string, data: string | Uint8Array) => writeOnce(path, data, values.force === true);

    if (command === "download") {
      if (source.kind === "dir") throw new Error("download needs a store, URL or archive source, not a directory");
      const bytes = await readArchive(source);
      const path = values.output ?? `${sourceName(source)}.${archiveExtension(bytes, source.kind === "amo")}`;
      await write(path, bytes);
      out.write(`Wrote ${path} (${bytes.length} bytes)\n`);
      return 0;
    }

    const { files, extensionId } = await readSource(source);
    const options = {
      locale: values.locale,
      extensionId,
      ignoreAssets: values["ignore-assets"]?.split(",").map((glob) => glob.trim()).filter(Boolean),
    };
    let report: Report;
    if (command === "report") {
      report = await inspect(files, options);
    } else {
      const result = await convert(files, { ...options, runtime: await loadRuntime(), esbuild: await loadEsbuild(), minify: values.minify });
      report = result.report;
      const path = values.output ?? `${slugify(report.extension.name)}.user.js`;
      await write(path, result.userscript);
      out.write(`Wrote ${path}\n`);
    }
    if (values.report) await write(values.report, `${JSON.stringify(report, null, 2)}\n`);
    out.write(`${formatReport(report)}\n`);
    return report.verdict === "unlikely" ? 2 : 0;
  } catch (error) {
    err.write(`ext2userscript: ${printable((error as Error).message)}\n`);
    return 1;
  }
}

/** Writes a new file; an existing one is overwritten only with --force. */
async function writeOnce(path: string, data: string | Uint8Array, force: boolean): Promise<void> {
  try {
    await writeFile(path, data, { flag: force ? "w" : "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${path} already exists (use --force to overwrite it)`);
    throw error;
  }
}

function remoteName(source: Source): string | undefined {
  switch (source.kind) {
    case "cws":
      return `${source.id} from the Chrome Web Store`;
    case "edge":
      return `${source.id} from Edge Add-ons`;
    case "amo":
      return `"${source.slug}" from addons.mozilla.org`;
    case "url":
      return source.url;
    default:
      return undefined;
  }
}

function archiveExtension(bytes: Uint8Array, firefox: boolean): string {
  if (bytes[0] === 0x43 && bytes[1] === 0x72 && bytes[2] === 0x32 && bytes[3] === 0x34) return "crx"; // "Cr24"
  return firefox ? "xpi" : "zip";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
