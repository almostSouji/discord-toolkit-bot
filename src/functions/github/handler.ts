import { Buffer } from "node:buffer";
import { URL } from "node:url";
import type { AttachmentPayload } from "discord.js";
import { codeBlock } from "discord.js";
import { fetch } from "undici";
import { trimLeadingIndent, truncateArray } from "../../util/array.js";
import { URL_REGEX } from "../../util/constants.js";
import { GistGitHubUrlRegex, NormalGitHubUrlRegex } from "./regex.js";
import { formatLine, generateHeader, resolveFileLanguage, resolveLines } from "./utils.js";

const SAFE_BOUNDARY = 100;

export enum GitHubUrlType {
	Normal,
	Gist,
	Diff,
}

export type GitHubMatchResult = {
	converter(url: string): string | null;
	opts: string | undefined;
	regex: RegExp;
	type: GitHubUrlType;
	url: string;
};

const validators = [
	{
		type: GitHubUrlType.Normal,
		regex: NormalGitHubUrlRegex,
		converter: (url: string): string => {
			return url
				.replace(">", "")
				.replace("github.com", "raw.githubusercontent.com")
				.replace(/\/(?:blob|(?:blame))/, "");
		},
	},
	{
		type: GitHubUrlType.Gist,
		regex: GistGitHubUrlRegex,
		converter: (url: string): string | null => {
			// eslint-disable-next-line unicorn/no-unsafe-regex
			const { id, opts } = new RegExp(GistGitHubUrlRegex, "").exec(url.replace(/(?:-L\d+)+/, ""))!.groups!;

			if (!id || !opts) {
				return null;
			}

			return `https://api.github.com/gists/${id}`;
		},
	},
];

export async function matchGitHubUrls(text: string): Promise<GitHubMatchResult[]> {
	const urls = new Set(text.matchAll(URL_REGEX));
	if (!urls.size) return [];

	const matches = Array.from(urls)
		.map(([url]) => {
			const match = validators.find((validator) => validator.regex.exec(url!));
			if (!match) return null;
			const regexMatch = match.regex.exec(url!);
			const { opts } = regexMatch!.groups!;
			if (!regexMatch || !regexMatch[0]) return null;

			return {
				url: regexMatch[0],
				opts,
				...match,
			};
		})
		.filter(Boolean) as GitHubMatchResult[];

	if (!matches.length) return [];
	return matches;
}

type ResolvedGitHubResult = {
	content: string;
	files: AttachmentPayload[];
};

export async function resolveGitHubResults(matches: GitHubMatchResult[]) {
	const results: ResolvedGitHubResult[] = [];

	for (const { url, opts, converter, type } of matches) {
		const rawData = converter(url);
		if (!rawData) continue;
		const rawFile: string | { files: Record<string, { content: string }> } | null = (await fetch(rawData).then((res) =>
			res.status === 200 ? (type === GitHubUrlType.Gist ? res.json() : res.text()) : null,
		)) as string | { files: Record<string, { content: string }> } | null;
		if (!rawFile) continue;
		const parsedFiles: Record<string, { parsed: { content: string }; raw: string }> = {};
		let fileContents: string | undefined;
		if (type === GitHubUrlType.Gist && typeof rawFile === "object") {
			for (const key in rawFile.files) {
				if (!Object.hasOwn(rawFile.files, key)) continue;
				parsedFiles[key.replaceAll(".", "-")] = { raw: key, parsed: rawFile.files[key]! };
			}

			fileContents = parsedFiles[opts!.replaceAll(/-L\d+/g, "").replaceAll(".", "-")]?.parsed.content;
		} else {
			fileContents = rawFile as string;
		}

		if (!fileContents) continue;
		const { startLine, endLine } = resolveLines(opts);
		const lang =
			type === GitHubUrlType.Gist
				? resolveFileLanguage(
						opts!
							.replaceAll(/-L\d+$/g, "")
							.replaceAll(/-L\d+$/g, "")
							.replaceAll("-", "."),
				  )
				: resolveFileLanguage(rawData);
		const path =
			type === GitHubUrlType.Gist
				? `${new URL(url).pathname}#file-${opts!.replaceAll(/-L\d+$/g, "").replaceAll(/-L\d+$/g, "")}`
				: new URL(url).pathname;
		const parsedLines = fileContents.split("\n");

		const [safeStartLine, safeEndLine] = [
			// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
			Math.min(startLine || 1, parsedLines.length),
			// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
			Math.min(endLine ? endLine : startLine || parsedLines.length, parsedLines.length),
		];

		const linesRequested = parsedLines.slice(safeStartLine - 1, safeEndLine);
		const hasCodeBlock = linesRequested.some((line) => line.includes("```"));

		const header = generateHeader({
			startLine: safeStartLine,
			endLine: safeEndLine,
			path,
		});

		if (hasCodeBlock) {
			results.push({
				content: header,
				files: [
					{
						attachment: Buffer.from(linesRequested.join("\n")),
						name: type === GitHubUrlType.Gist ? `${path}.${lang}` : path,
					},
				],
			});
			continue;
		}

		const formattedLines = trimLeadingIndent(linesRequested).map((line, index) =>
			formatLine(line, safeStartLine, safeEndLine, index, lang === "ansi"),
		);

		const safeLinesRequested = truncateArray(formattedLines, 2_000 - (header.length + SAFE_BOUNDARY + lang.length));

		const content = [
			generateHeader({
				startLine: safeStartLine,
				endLine: safeLinesRequested.length + safeStartLine - 1,
				path,
				ellipsed: safeLinesRequested.length !== linesRequested.length,
			}),
			codeBlock(lang, safeLinesRequested.join("\n") || "Couldn't find any lines"),
		].join("\n");

		if (content.length >= 2_000) {
			results.push({
				content: header,
				files: [
					{
						attachment: Buffer.from(linesRequested.join("\n")),
						name: type === GitHubUrlType.Gist ? `${path}.${lang}` : path,
					},
				],
			});
		} else {
			results.push({
				content,
				files: [],
			});
		}
	}

	return results;
}
