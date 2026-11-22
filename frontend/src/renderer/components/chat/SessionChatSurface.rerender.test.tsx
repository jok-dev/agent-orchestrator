import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { Profiler, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { conversationSkillsQueryKey, type ConversationQueryResult } from "../../hooks/useConversation";
import { workspaceQueryKey } from "../../hooks/useWorkspaceQuery";
import { chatFixtureLongHistory } from "../../lib/chat-fixture";
import type { ChatSkill, ConversationSnapshot } from "../../types/conversation";
import type { WorkspaceSession } from "../../types/workspace";
import { TooltipProvider } from "../ui/tooltip";
import type { ChatWorkspace } from "./ChatWorkspace";

// A chat surface renders again for reasons that change nothing it shows: a send
// in another chat, a list refetch. These tests mount the real surface, workspace
// and message rows, render the surface again that way, and check what reached
// the transcript.

const probe = vi.hoisted(() => ({
	conversation: undefined as ConversationQueryResult | undefined,
	/** The text of a human message row, once for each time the row rendered. */
	humanRowRenders: [] as string[],
	/** The props of each render of the chat workspace. */
	workspaceRenders: [] as ComponentProps<typeof ChatWorkspace>[],
	sideChats: {
		sides: [],
		loaded: true,
		pending: false,
		activeId: undefined,
		panel: null,
		show: () => {},
		create: async () => ({ id: "side" }),
		send: async () => undefined,
		addReference: async () => undefined,
	},
}));

// The conversation is a fixture. Everything else the surface reads from this
// module is the real hook: the commands, the skills, the file paths.
vi.mock("../../hooks/useConversation", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../hooks/useConversation")>()),
	useConversation: () => probe.conversation,
}));

// Side chats make their own requests and have their own tests.
vi.mock("./IndependentSideChats", () => ({ useIndependentSideChats: () => probe.sideChats }));

// A human message row calls this hook once per render, so it counts them.
vi.mock("./sentComposerTokens", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./sentComposerTokens")>();
	return {
		...actual,
		useComposerTokenRenderer: (sessionId: string, text: string) => {
			probe.humanRowRenders.push(text);
			return actual.useComposerTokenRenderer(sessionId, text);
		},
	};
});

vi.mock("./ChatWorkspace", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./ChatWorkspace")>();
	return {
		...actual,
		ChatWorkspace: (props: ComponentProps<typeof actual.ChatWorkspace>) => {
			probe.workspaceRenders.push(props);
			return <actual.ChatWorkspace {...props} />;
		},
	};
});

import { SessionChatSurface } from "./SessionChatSurface";

const history = chatFixtureLongHistory(3);

const session = {
	id: history.sessionId,
	workspaceId: "proj-1",
	workspaceName: "my-app",
	title: "chat worker",
	provider: "codex",
	kind: "worker",
	mode: "chat",
	status: "working",
	updatedAt: "2026-11-21T00:00:00Z",
	prs: [],
} satisfies WorkspaceSession;

/** Each human message names a skill the agent lists and the side-chat command. */
const snapshot: ConversationSnapshot = {
	...history,
	// Side chats can be created, so the surface offers /btw ahead of the agent's skills.
	capabilities: ["resume"],
	items: history.items.map((item) =>
		item.kind === "message" && item.role === "user" ? { ...item, text: `/review then /btw ${item.text}` } : item,
	),
};
const humanTexts = snapshot.items.flatMap((item) => (item.kind === "message" && item.role === "user" ? [item.text] : []));

const review: ChatSkill = { name: "review", displayName: "review", description: "Review the changes" };
const deploy: ChatSkill = { name: "deploy", displayName: "deploy", description: "Ship it" };

/** The query cache tells its readers of a change on a timer, so a change is seen a tick later. */
async function nextTick() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

/** The skills and side-chat commands marked in the human messages, top to bottom. */
function markedSkills() {
	return Array.from(document.querySelectorAll('[data-message-token="skill"]'), (node) => node.textContent);
}

/** Mounts the surface on a settled chat whose agent has reported these skills. */
async function mountChat(skills: ChatSkill[]) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchOnMount: false, refetchOnWindowFocus: false, refetchOnReconnect: false } },
	});
	// No daemon answers here. Keep the workspace read local, as the app's query context does.
	client.setQueryData(workspaceQueryKey, []);
	client.setQueryData(conversationSkillsQueryKey(session.id), skills);
	const commits: string[] = [];
	render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<Profiler id="chat-surface" onRender={(_id, phase) => commits.push(phase)}>
					<SessionChatSurface session={session} />
				</Profiler>
			</TooltipProvider>
		</QueryClientProvider>,
	);
	// The requests no daemon answers settle over a few ticks. Nothing is counted
	// until a tick passes with nothing rendered.
	for (let quiet = false, ticks = 0; !quiet; ticks += 1) {
		if (ticks === 50) throw new Error("The chat surface never stopped rendering.");
		const seen = commits.length;
		await nextTick();
		quiet = commits.length === seen;
	}
	return { client, commits };
}

/**
 * Another chat sends a message. Its echo lands in the renderer-wide cache every
 * chat surface reads, so this surface renders again with nothing of its own changed.
 */
async function sendInAnotherChat(client: QueryClient) {
	client.setQueryData(["conversation-local-echos"], {
		"another-chat": [{ clientMessageId: "sent-elsewhere", text: "hello", createdAt: "2026-11-21T10:00:00.000Z" }],
	});
	await nextTick();
}

beforeEach(() => {
	window.localStorage.clear();
	probe.humanRowRenders.length = 0;
	probe.workspaceRenders.length = 0;
	probe.conversation = { snapshot, isLoading: false, hasOlder: false, isLoadingOlder: false, loadOlder: () => {} };
});

describe("SessionChatSurface rendered again with nothing of its own changed", () => {
	it("does not re-render its human messages", async () => {
		const { client, commits } = await mountChat([review, deploy]);
		// Every human message is on screen, with its skill and the side-chat command marked.
		expect(new Set(probe.humanRowRenders)).toEqual(new Set(humanTexts));
		expect(markedSkills()).toEqual(humanTexts.flatMap(() => ["/review", "/btw"]));
		probe.humanRowRenders.length = 0;
		commits.length = 0;

		await sendInAnotherChat(client);

		// The surface did render again; no human message did.
		expect(commits.length).toBeGreaterThan(0);
		expect(probe.humanRowRenders).toEqual([]);
	});

	it("hands the chat the same skills, file paths and local echoes", async () => {
		const { client } = await mountChat([review, deploy]);
		const before = probe.workspaceRenders.at(-1)!;
		const rendersBefore = probe.workspaceRenders.length;

		await sendInAnotherChat(client);

		expect(probe.workspaceRenders.length).toBeGreaterThan(rendersBefore);
		const after = probe.workspaceRenders.at(-1)!;
		// The agent's skills behind the side-chat command.
		expect(after.skills?.map((skill) => skill.name)).toEqual(["btw", "review", "deploy"]);
		expect(after.skills).toBe(before.skills);
		// No file list has loaded and this chat has no echo of its own: both are empty.
		expect(after.filePaths).toEqual([]);
		expect(after.filePaths).toBe(before.filePaths);
		expect(after.localEchos).toEqual([]);
		expect(after.localEchos).toBe(before.localEchos);
	});
});

describe("SessionChatSurface when the agent's skills change", () => {
	it("marks a skill in the messages already sent once the agent lists it", async () => {
		// An agent publishes its skills a few seconds after it starts.
		const { client } = await mountChat([deploy]);
		expect(markedSkills()).toEqual(humanTexts.map(() => "/btw"));

		client.setQueryData(conversationSkillsQueryKey(session.id), [deploy, review]);
		await nextTick();

		expect(markedSkills()).toEqual(humanTexts.flatMap(() => ["/review", "/btw"]));
	});
});
