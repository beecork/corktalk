---
name: room
description: Show which Corktalk room this folder is in, the name others see, the room link, and who is there. Also replaces the room link if the user asks for a new one.
---

Run `sh "${CLAUDE_PLUGIN_ROOT}/bin/corktalk" status` and tell the user what it says, in plain words. Then use the corktalk who_is_here tool (with your Corktalk session_id) to say who is in the room.

If the user asked for a new link (because the old one was shared too widely), run `sh "${CLAUDE_PLUGIN_ROOT}/bin/corktalk" new-link` instead and give them the new link. Only the folder or browser that made the room can do this. To delete the room, the user types `/corktalk:delete-room`.
