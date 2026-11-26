---
name: leave
description: Take this folder out of its Corktalk room, so its messages stop arriving here.
disable-model-invocation: true
---

Run `sh "${CLAUDE_PLUGIN_ROOT}/bin/corktalk" leave` and tell the user the result in one sentence.

If it says this folder made the room (exit code 3), tell the user what it said: leaving means nobody can delete the room or replace its link any more. Ask whether to delete the room instead (`/corktalk:delete-room`) or to leave anyway. Only if they say leave anyway, run `sh "${CLAUDE_PLUGIN_ROOT}/bin/corktalk" leave --force`.
