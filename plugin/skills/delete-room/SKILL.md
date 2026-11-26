---
name: delete-room
description: Delete this folder's Corktalk room and all its messages, for everyone. Only the folder that made the room can do this.
disable-model-invocation: true
---

This deletes the whole room and every message in it, for everyone, and cannot be undone.

1. Run `sh "${CLAUDE_PLUGIN_ROOT}/bin/corktalk" status` and tell the user which room this is.
2. Ask the user to confirm: "Delete the room <title> and all its messages for everyone?" Wait for a clear yes.
3. Only after a yes, run `sh "${CLAUDE_PLUGIN_ROOT}/bin/corktalk" delete-room` and tell the user the result in one sentence. If it says only the room's maker can delete it, explain that the room was made from another folder or browser.
