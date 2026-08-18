<img width="100%" alt="eve Software Factory Banner" src=".github/banner.png" />

# Foreman

[![Docs](https://img.shields.io/badge/Documentation-000?style=flat-square&logo=readthedocs&logoColor=FFF&labelColor=000&color=000)](https://ask-foreman.dev/docs)
[![Agent Stack](https://img.shields.io/badge/Agent%20Stack-000?style=flat-square&logo=vercel&logoColor=FFF&labelColor=000&color=000)](https://vercel.com/kb/agent-stack)
[![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

Meet **Foreman**, Acquisity's general-purpose agent. Skills define its specialist modes, and the software factory is one of them: when a work item asks Foreman to fix, build, or change something in your repository, it loads the factory-pipeline skill and runs the full line. With no skill loaded it still handles whatever you delegate, from questions and summaries to triage and routing.

The factory takes tasks from GitHub and Linear, moves each one through four stations, and delivers a reviewed draft pull request on your repository. You review, mark ready, and merge.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?project-name=eve-software-factory&repository-name=eve-software-factory-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-software-factory-template&env=FACTORY_REPO,FACTORY_LABEL&envDefaults=%7B%22FACTORY_LABEL%22%3A%22factory%22%7D&envDescription=FACTORY_REPO%20is%20the%20owner%2Frepo%20the%20factory%20works%20on.%20FACTORY_LABEL%20is%20the%20issue%20label%20that%20hands%20an%20issue%20to%20the%20factory%3B%20the%20default%20label%20is%20fine.&connect=%5B%7B%22type%22%3A%22github%22%2C%22env%22%3A%22GITHUB_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fgithub%22%7D%2C%7B%22type%22%3A%22linear%22%2C%22env%22%3A%22LINEAR_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Flinear%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22public%22%7D%5D)

## How it works

Foreman is a general-purpose agent whose specialist modes are skills. The factory-pipeline skill is the software factory: load it and Foreman runs the full station line.

- **Classifier** triages the task: type, priority, complexity, actionable or not. When the task isn't actionable, Foreman asks the requester instead of building the wrong thing.
- **Analyst** turns it into a plan with acceptance criteria, working from a live checkout of your repository.
- **Implementer** executes the plan in its own sandbox, verifies with your repo's own checks, and pushes a branch.
- **Reviewer** independently judges everything against the real diff, with evidence for each verdict.

Each station is its own agent with its own instructions, sandbox, and tools. The Reviewer sees only the pushed branch, never the Implementer's reasoning. Between runs, Foreman keeps a **factory brain**: notes about your repository that every run starts from. See [the pipeline](https://ask-foreman.dev/docs/pipeline) and [factory memory](https://ask-foreman.dev/docs/memory) for the full picture.

## How work arrives

- **Label an issue `factory`.** The pipeline runs on its own, posts progress as stations complete, and ends with a draft PR linked to the issue.
- **@mention it on an issue or PR.** Mentions from repo owners, members, and collaborators start an interactive session.
- **Delegate in Linear.** Linear Agent Sessions run the same pipeline and report progress back in Linear.
- **The dev TUI.** Hand it a task locally.
- **Red CI on a factory PR.** Foreman diagnoses the failure and pushes a fix to its own branches, never yours.
- **Someone opens a pull request.** Foreman posts one orienting comment for reviewers: a summary, not a review.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?project-name=eve-software-factory&repository-name=eve-software-factory-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-software-factory-template&env=FACTORY_REPO,FACTORY_LABEL&envDefaults=%7B%22FACTORY_LABEL%22%3A%22factory%22%7D&envDescription=FACTORY_REPO%20is%20the%20owner%2Frepo%20the%20factory%20works%20on.%20FACTORY_LABEL%20is%20the%20issue%20label%20that%20hands%20an%20issue%20to%20the%20factory%3B%20the%20default%20label%20is%20fine.&connect=%5B%7B%22type%22%3A%22github%22%2C%22env%22%3A%22GITHUB_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fgithub%22%7D%2C%7B%22type%22%3A%22linear%22%2C%22env%22%3A%22LINEAR_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Flinear%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22public%22%7D%5D)

The Vercel deploy flow sets up everything: the **GitHub** connector, **Linear** connector, **Vercel Blob** store, and a prompt for the `FACTORY_REPO` and `FACTORY_LABEL` environment variables.

Two things must line up before the first deployment can finish. `FACTORY_REPO` must name a real repository in `owner/repo` format, and the GitHub App behind the connector you select must be installed with access to that repository. The deployment clones `FACTORY_REPO` up front to prewarm the station sandboxes, so a repository the app cannot reach fails the deploy with a `Cannot access <owner/repo>` error; install the app on the repository (or fix the value), then redeploy.

Configuration (see `.env.example`):

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `FACTORY_REPO` | Yes | — | An existing GitHub repository in `owner/repo` format; the selected GitHub App must have access to it (the deploy fails otherwise) |
| `FACTORY_SETUP_COMMAND` | No | — | Runs once inside the sandbox checkout at build time (e.g. `pnpm install`), so every run starts with dependencies already installed |
| `FACTORY_LABEL` | No | `factory` | The issue label that hands an issue to the factory |
| `FACTORY_BRANCH_PREFIX` | No | `factory/` | Branch prefix marking the factory's own PRs, which are the only branches automated CI fixes touch |
| `FACTORY_BOT_NAME` | No | the GitHub App's slug | The `@mention` name, resolved from the connector automatically when unset |
| `GITHUB_CONNECTOR` / `LINEAR_CONNECTOR` | Yes | — | Set automatically from Vercel Connect connector UIDs |

## Local development

Link the project you deployed (or a fresh one), pull its environment, and start the TUI:

```bash
vercel link
vercel env pull
pnpm dev
```

Hand the agent a task ("users report the password reset email arrives twice, fix it") and watch the four stations fire in order, ending in a draft PR on `FACTORY_REPO`.

## Resources

- [Foreman Docs](https://ask-foreman.dev/docs)
- [Vercel Connect](https://vercel.com/docs/connect)
- [eve Documentation](https://eve.dev/docs/introduction)
- [GitHub Tools eve Extension](https://github-tools.com/frameworks/eve-extension)

## Explore more templates

- [eve Marketing Team](https://vercel.com/templates/eve/eve-marketing-team)
- [eve Personal Agent](https://vercel.com/templates/nuxt/eve-personal-agent)
- [eve Sanity Copilot](https://vercel.com/templates/eve/eve-sanity-copilot)
