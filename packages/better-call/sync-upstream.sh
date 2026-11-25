#!/bin/bash

# Script to sync fork with upstream repository
# Upstream: https://github.com/better-auth/better-call.git
# Origin: git@github.com:colyseus/better-call.git

set -e

UPSTREAM_URL="git@github.com:better-auth/better-call.git"
# Not "main": upstream 1.4.x renames wildcard params (rou3 0.9), and published
# @colyseus/core depends on ^1.3.x. Upstream stopped backporting here after
# 1.3.8, so newer fixes must be cherry-picked from upstream/main.
UPSTREAM_BRANCH="v1.3.x"

# Check if upstream remote exists, add if not
if ! git remote | grep -q "^upstream$"; then
    echo "Adding upstream remote..."
    git remote add upstream "$UPSTREAM_URL"
else
    # Ensure upstream remote has correct URL and fetch refspec
    git remote set-url upstream "$UPSTREAM_URL"
    git config remote.upstream.fetch "+refs/heads/*:refs/remotes/upstream/*"
fi

echo "Fetching upstream..."
if ! git fetch upstream; then
    echo "Error: Failed to fetch upstream. Check your network connection."
    exit 1
fi

# Verify upstream branch exists
if ! git rev-parse --verify upstream/$UPSTREAM_BRANCH >/dev/null 2>&1; then
    echo "Error: upstream/$UPSTREAM_BRANCH not found after fetch."
    exit 1
fi

echo "Checking out main branch..."
git checkout main

echo "Merging upstream/$UPSTREAM_BRANCH into main..."
git merge upstream/$UPSTREAM_BRANCH

echo "✓ Successfully synced with upstream!"
