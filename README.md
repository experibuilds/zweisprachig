# Zweisprachig
Rough dev notes → bilingual (DE/EN) Slack update. Free (Gemini free tier).

## Go live (once, ~5 min)
```bash
./setup.sh            # asks for GitHub/Vercel login + free Gemini key, then deploys
```

## Every change after
Tell Claude Code what you want — it follows `CLAUDE.md` and runs:
```bash
./ship.sh "feat: add French" minor
```
Push = auto-deploy. Every version tagged in Git; one-click rollback in Vercel.
