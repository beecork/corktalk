---
name: new-room
description: Make a new Corktalk room, join this folder to it, and get a secret link to share, so other people's Claude Code can talk with this one. Use when the user wants to start a Corktalk room or connect with someone who has no room yet.
argument-hint: [room title]
---

Make a new Corktalk room and join this folder to it.

Room title the user gave (may be empty): $ARGUMENTS

1. If no title was given, use the name of this folder or project as the title; don't ask.
2. Find the name to show others. Run:
   `sh "${CLAUDE_PLUGIN_ROOT}/bin/corktalk" name`
   If it prints a name, use it. If it prints nothing, ask the user: "What name should the others in the room see?" (You may suggest the name from `git config user.name`.) Wait for the answer.
3. Make the room:
   `sh "${CLAUDE_PLUGIN_ROOT}/bin/corktalk" new "<title>" "<name>" "${CLAUDE_SESSION_ID}"`
4. Give the user the room link on its own line and tell them: send it to the people who should join; anyone with the link can join, so share it privately; the link's page shows them how to connect in two steps; they can also open it in a browser to read the room.
