import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPOSITORIES_PATH = join(__dirname, "repositories.json");
const OUTPUT_PATH = join(__dirname, "dist", "payloads.json");

function parseReleasesUrl(releasesUrl) {
  const url = new URL(releasesUrl);
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length < 3 || parts[parts.length - 1] !== "releases") {
    throw new Error(`Invalid releases URL: ${releasesUrl}`);
  }

  const owner = parts[0];
  const repo = parts[1];

  if (url.hostname === "github.com") {
    return {
      platform: "github",
      owner,
      repo,
      releasesApiUrl: `https://api.github.com/repos/${owner}/${repo}/releases`,
      repoApiUrl: `https://api.github.com/repos/${owner}/${repo}`,
    };
  }

  return {
    platform: "gitea",
    owner,
    repo,
    releasesApiUrl: `${url.origin}/api/v1/repos/${owner}/${repo}/releases`,
    repoApiUrl: `${url.origin}/api/v1/repos/${owner}/${repo}`,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "payloads-generator",
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }

  return response.json();
}

function pickElfAsset(assets, repoName) {
  const elfAssets = assets.filter((asset) => asset.name.endsWith(".elf"));

  if (elfAssets.length === 0) {
    throw new Error(`No .elf asset found for ${repoName}`);
  }

  const normalizedName = repoName.replace(/-/g, "_");
  const preferred = elfAssets.find(
    (asset) =>
      asset.name === `${repoName}.elf` ||
      asset.name === `${normalizedName}.elf` ||
      asset.name.includes(repoName) ||
      asset.name.includes(normalizedName),
  );

  return preferred ?? elfAssets[0];
}

function extractChecksum(asset) {
  if (!asset.digest) {
    return undefined;
  }

  const [, hash] = asset.digest.split(":");
  return hash || undefined;
}

async function computeChecksum(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "payloads-generator" },
  });

  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }

  const hash = createHash("sha256");

  for await (const chunk of response.body) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

async function buildPayload(repository) {
  const { releasesApiUrl, repoApiUrl } = parseReleasesUrl(
    repository.releases,
  );

  const [releases, repoInfo] = await Promise.all([
    fetchJson(releasesApiUrl),
    fetchJson(repoApiUrl).catch(() => null),
  ]);

  if (!Array.isArray(releases) || releases.length === 0) {
    throw new Error(`No releases found for ${repository.name}`);
  }
  
  const release = releases.sort((a, b) =>
    String(b.tag_name).localeCompare(String(a.tag_name), undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  )[0];

  const asset = pickElfAsset(release.assets ?? [], repository.name);
  const payload = {
    name: `${repository.name} - ${release.tag_name}`,
    filename: asset.name,
    url: asset.browser_download_url,
    description:
      repository.description ??
      repoInfo?.description ??
      release.body?.split("\n")[0] ??
      "",
    version: release.tag_name,
  };

  let checksum = extractChecksum(asset);
  if (!checksum) {
    console.log(`Computing checksum for ${repository.name}...`);
    checksum = await computeChecksum(asset.browser_download_url);
  }

  payload.checksum = checksum;

  return payload;
}

async function main() {
  const config = JSON.parse(await readFile(REPOSITORIES_PATH, "utf8"));
  const payloads = [];

  for (const repository of config.repositories) {
    console.log(`Fetching latest release for ${repository.name}...`);
    payloads.push(await buildPayload(repository));
  }

  const output = {
    name: config.name ?? "Custom Payloads",
    payloads,
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Generated ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
