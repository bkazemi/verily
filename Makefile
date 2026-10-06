# A release, in the order it has to happen: the work is already committed, the version is
# bumped and committed, and only then is the worker deployed and the package published. The
# version is built into the bundle and named in the README's CDN URLs, so a deploy or a
# publish ahead of the bump ships the old number.
#
#   make release                 the next patch version
#   make release minor           the next minor version, or major for the next major
#   make release VERSION=0.1.0   a version you name
#
# Each step is also a target of its own, to pick up a release that stopped part way.

VERSION_FILES := package.json package-lock.json src/version.ts README.md

CURRENT := $(shell node -p "require('./package.json').version")
# Which part to bump is a word after the target. Make reads it as a goal of its own, so
# each is also a target that does nothing.
BUMPS := $(filter major minor patch,$(MAKECMDGOALS))

ifneq ($(words $(BUMPS)),$(words $(firstword $(BUMPS))))
$(error Name one of major, minor or patch, not '$(BUMPS)')
endif

BUMP := $(or $(BUMPS),patch)

# The parts below the one bumped go back to zero, as 0.1.4 to 0.2.0.
VERSION ?= $(shell node -p "const [a, b, c] = '$(CURRENT)'.split('.').map(Number); ({ major: [a + 1, 0, 0], minor: [a, b + 1, 0], patch: [a, b, c + 1] })['$(BUMP)'].join('.')")

# The steps depend on running in the order they are listed.
.NOTPARALLEL:
.PHONY: release clean-tree bump verify commit deploy publish major minor patch

major minor patch:
	@:

release: clean-tree bump verify commit deploy publish

# A bump commit holds the version and nothing else, so everything else is committed first.
clean-tree:
	@test -z "$$(git status --porcelain --untracked-files=no)" || \
		{ echo 'Commit your work first: the tree has uncommitted changes.' >&2; exit 1; }

bump:
	npm version $(VERSION) --no-git-tag-version
	sed -i "s/'v$(subst .,\.,$(CURRENT))'/'v$(VERSION)'/" src/version.ts
	sed -i 's/verily@$(subst .,\.,$(CURRENT))/verily@$(VERSION)/g' README.md

# The example imports the package by name, so the type check needs the build's output.
verify:
	npm run build
	npm run check
	npm run format:check
	npm test

commit:
	git commit -m "chore: bump version to $$(node -p "require('./package.json').version")" -- $(VERSION_FILES)

deploy:
	npm run cloudflare:deploy

publish:
	npm publish
