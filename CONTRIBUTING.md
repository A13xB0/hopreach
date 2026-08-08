# Contributing to HopReach

**HopReach is not yet open to external contributions.** The licensing needs
settling first — see [`CLA.md`](CLA.md), which is drafted but not adopted. If
you have found a bug or want a feature, please open an issue; that is welcome
now and needs no agreement from anyone.

The rest of this describes how contributions will work once that is resolved.

## Before you write code

Open an issue first for anything beyond a typo. HopReach models radio
propagation over terrain, and a change that looks like a small refactor can
quietly alter what the tool tells someone about whether a link will work. It is
much cheaper to disagree about an approach in an issue than in a review of
finished code.

## The agreement

Every pull request must include:

> I have read the HopReach CLA and I agree to it.

Read [`CLA.md`](CLA.md) first — properly, not just the last line. In short: you
keep your copyright, and you grant A13xB0 permission to use your contribution
under other licences, including proprietary ones. If that is not acceptable to
you, say so instead of contributing; that is a fair position and far better
raised early.

## Standards

[`CLAUDE.md`](CLAUDE.md) holds the conventions this project is actually held to
— style guide, file and function limits, and the domain rules that are easy to
get wrong. It is not advisory. Read it before your first pull request.

Checks that must pass, and that CI enforces:

```bash
gofmt -l .          # must be empty
go vet ./...
golangci-lint run
go test ./...
npx playwright test # UX suite
```

## What gets a change rejected

- **A propagation change with no test pinning the numbers.** If a result moves,
  the diff must say by how much and why. "Refactor, no behaviour change" is a
  claim, and in this codebase it needs evidence.
- **Rounding a marginal link up.** People plan trips on these answers. If a path
  is borderline, it must say borderline.
- **Presenting one direction as "in range".** Reachability is asymmetric; a
  result that does not say *which way* works is wrong even when its arithmetic
  is right.
- **A new dependency without a line justifying it.**

## Reporting a security issue

Do not open a public issue. Email alex@hectospark.co.uk with what you found and
how to reproduce it.
