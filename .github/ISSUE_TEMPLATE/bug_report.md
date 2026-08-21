---
name: Bug report
about: Report something broken — please include logs and a photo/screenshot
title: "[Bug] "
labels: bug
assignees: ''
---

**What happened?**
A clear description of the bug.

**Steps to reproduce**
1. Go to …
2. Send / …
3. See error

**Expected behaviour**
What you expected instead.

**Logs**
- Self-host: `journalctl -u athena -n 100 --no-pager` (redact secrets)
- Website: browser console output (F12 → Console)
Paste the relevant part below:

```
[paste logs here]
```

**Screenshot / photo**
If visual, attach a screenshot. Drag it into this box.

**Setup**
- Deployment: self-hosted Node / Cloudflare Worker
- OS: e.g. Ubuntu 22.04
- Node version (`node -v`):
- Athena version (from `/api/health`):

**Additional context**
Anything else — recent changes, related issues, what you already tried.
