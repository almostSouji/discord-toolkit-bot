import { Command } from "@yuudachi/framework";
import type { InteractionParam, CommandMethod, ArgsParam } from "@yuudachi/framework/types";
import type { AttachmentPayload } from "discord.js";
import kleur from "kleur";
import { matchGitHubUrls, resolveGitHubResults } from "../functions/github/handler.js";
import type { GithubResolveContextCommand } from "../interactions/context/githubResolveContext.js";

kleur.enabled = true;

export default class extends Command<typeof GithubResolveContextCommand> {
	public constructor() {
		super(["Resolve GitHub links"]);
	}

	public override async messageContext(
		interaction: InteractionParam<CommandMethod.MessageContext>,
		args: ArgsParam<typeof GithubResolveContextCommand>,
	): Promise<void> {
		const matches = await matchGitHubUrls(args.message.content);
		if (!matches.length) {
			await interaction.reply({
				ephemeral: true,
				content: "No GitHub links with specified lines to resolve found in this message.",
			});
			return;
		}

		const resolvedMatches = await resolveGitHubResults(matches);
		if (!resolvedMatches.length) {
			await interaction.reply({
				ephemeral: true,
				content: "No GitHub links with specified lines to resolve found in this message.",
			});
			return;
		}

		console.dir(resolvedMatches);

		const [contentParts, files] = resolvedMatches.reduce(
			(accumulator, current) => {
				accumulator[0].push(current.content);
				accumulator[1].push(...current.files);
				return accumulator;
			},
			[[] as string[], [] as AttachmentPayload[]],
		);
		const content = contentParts?.join("\n");

		await interaction.reply({
			ephemeral: true,
			content: content.slice(0, 2_000),
			files,
		});
	}
}
