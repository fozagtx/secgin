---
name: secgin
description: Guide for the local-source VDH/VVS security research harness. Use when the operator wants authorized Web2/Web3 source review, MCP tools harness_plan harness_run harness_status, x-ray, solidity-auditor, fizz, or Pashov skills. Not a canned audit product and not a live scanner.
license: MIT
compatibility: Requires a host that loads Agent Skills and MCP (Agent Plugins 1.0, or any CLI/cloud agent with those surfaces).
---

# secgin

This Skill teaches **the host agent** how to operate the harness. The host is whatever TUI or cloud agent loaded this plugin. The JSON worker is the backbone; it does not care which app spawned it. Worker models are bug-bounty hunters: Web2 or smart-contract bugs that an attacker could cash in. Impact first. MCP tools `harness_models`, `harness_plan`, `harness_run`, `harness_status`, and `harness_evaluate` spawn that worker. Do not invent a target, demo finding, or mock client.

## First actions

1. Confirm the operator has a real `scope.json` beside a tree they control. Required keys are documented in the README section "scope.json". There is no example target.
2. Call `harness_models`. Pick **three different catalog models** (recon, hunter, validator). Hunter ≠ validator. Hunt compute is the `{provider,id}` pairs in their `scope.json`.
3. Call `harness_plan` with their `scope.json`. Fix the scope until it succeeds. Web3 plans must list twelve `hunt:web3:*` cells.
4. Only then call `harness_run` with `confirmed=true`, their scope, and an output directory **outside** the source root. That run is recon/x-ray → optional fizz → twelve auditor hunts → validate → VVS.
5. After a run: `harness_status`. Confirmed findings stay **0** until a human reproduces.

x-ray, solidity-auditor, and fizz are names for harness stages. Call `harness_run`. Do not execute vendored Pashov playbooks (`enumerate.sh`, forge coverage, Echidna, Medusa). Models declare VDH/VVS tools; they cannot execute tools, patches, or tests.
