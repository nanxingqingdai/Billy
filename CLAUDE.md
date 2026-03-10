# CLAUDE.md — AI Assistant Guide for Billy

## Project Overview

**Billy** is a project in its earliest stage. At the time of writing, the repository contains:

- `README.md` — a stub with only the project name
- `LICENSE` — Apache License 2.0
- No source code has been committed yet

This file will be updated as the project evolves. AI assistants should treat this as a greenfield codebase and defer to the conventions below when making contributions.

---

## Repository Structure

```
Billy/
├── CLAUDE.md       # This file — AI assistant guide
├── LICENSE         # Apache License 2.0
└── README.md       # Project readme (stub)
```

As source code is added, this section should be updated to reflect the actual directory layout.

---

## License

This project is licensed under the **Apache License 2.0**. All contributions must be compatible with this license. Do not introduce dependencies with GPL, AGPL, or other copyleft licenses without explicit approval.

---

## Git Workflow

### Branch Naming

- Feature branches: `feature/<short-description>`
- Bug fixes: `fix/<short-description>`
- AI-driven tasks: `claude/<task-id>` (automatically assigned by the Claude Code agent)

### Commit Style

- Use short, imperative commit messages (e.g., `Add user authentication`, not `Added user authentication`)
- Keep the subject line under 72 characters
- Add a blank line before any body/detail paragraphs

### Branch Protection

- Never push directly to `master` without review
- Always push to the designated feature branch and open a pull request

---

## Development Conventions

Since no code has been written yet, these are the baseline conventions AI assistants should follow when the project is built out:

### General

- Prefer simplicity over cleverness — write the minimum code needed to satisfy requirements
- Do not add features, abstractions, or utilities that are not explicitly required
- Avoid over-engineering; three similar lines are better than a premature abstraction
- Do not add comments unless the logic is non-obvious

### File and Directory Layout

- Group related files into directories by domain or feature, not by type (prefer `user/` with handler + model + tests over `handlers/`, `models/`, `tests/` top-level dirs)
- Keep configuration files at the repository root

### Testing

- Write tests alongside the code they cover
- Tests must pass before merging any change
- Do not disable or skip tests without a clear, documented reason

### Security

- Validate all external input at system boundaries
- Do not introduce SQL injection, XSS, command injection, or other OWASP Top 10 vulnerabilities
- Never commit secrets, credentials, or API keys

---

## Working with This Repository

### What AI Assistants Should Do

1. Read this file at the start of every session to understand the current state of the project
2. Update the **Repository Structure** section whenever files or directories are added or removed
3. Update any section of this file that becomes stale as the project evolves
4. Follow the git workflow above for all commits and pushes
5. Keep changes minimal and focused — only touch what is necessary for the task

### What AI Assistants Should Avoid

- Do not push to `master` directly
- Do not introduce dependencies without clear justification
- Do not rewrite or refactor code that is not related to the current task
- Do not create files that are not needed (e.g., unsolicited documentation, example scripts)
- Do not amend published commits — always create a new commit to fix issues

---

## Updating This File

This CLAUDE.md should be kept current. Whenever significant changes occur — new language/framework chosen, directory structure established, CI/CD pipelines added, testing strategy decided — update the relevant sections here.

Last updated: 2026-03-10
