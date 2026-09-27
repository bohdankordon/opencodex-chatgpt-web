# OpenCodex 2.67 provider-contract fixtures

Sanitized, normalized representations of the Codex 0.158.0-alpha.2.1 / OpenCodex 2.67.0
Responses contract on the Codex-to-OpenCodex-to-loopback-provider path. These are not
byte-identical packet dumps: IDs, timestamps, tokens, paths, and prose are synthetic.
Raw experimental captures were deleted after transcription; nothing here carries real
usernames, home paths, keys, tokens, or installation/session/thread/turn IDs.

## Provenance labels

1. CAPTURED: field-for-field structure observed on the wire in an isolated loopback
   capture (fresh TEMP homes, loopback fake openai-responses provider, rejecting
   network sink, no real inference, no browser). Real Codex 0.158 drove every turn,
   including a genuine auto-compaction cycle forced by a small context window.
2. CAPTURED + SOURCE: captured Codex-side structure transformed per exact OpenCodex
   2.67 source (pure request functions), deterministic for the loopback provider class.
3. SOURCE-CONFIRMED: shape proven by exact installed OpenCodex 2.67 source alone
   (request-strips, custom/tool-search/namespace compat, routed-compaction builder).
4. SYNTHETIC REPRESENTATIVE VALUE: placeholder prose/IDs/timestamps standing in for
   redacted content; structure, not content, is asserted.

## Files

1. `codex-first-turn.json` (CAPTURED): normal Codex first turn as Codex mints it.
   Top-level keys, tool-codec shapes, input roles, and the client_metadata envelope
   are wire-observed. Instructions prose and message text are synthetic.
2. `provider-first-turn.json` (CAPTURED + SOURCE): the same turn as a non-canonical
   loopback provider receives it. ID/passthrough/access_programs removal plus tool
   lowering follow OpenCodex 2.67 source exactly; the Codex side is captured.
3. `replay-continuation.json` (CAPTURED + SOURCE): full-history continuation. No
   previous_response_id; stable thread/session identity; new turn ID; prior assistant
   output and tool round replayed; steering appended.
4. `compaction.json` (CAPTURED + SOURCE): three bodies sharing one synthetic thread.
   `v2_trigger` is the wire-observed Codex auto-compaction request, including the
   `compaction` metadata object that resolves the S4A blocker. `routed_summarizer`
   is the provider-bound rewrite per OpenCodex source. `replay` is the wire-observed
   post-compaction turn replaying the stored compaction item verbatim.
5. `tools.json` (CAPTURED + SOURCE): declaration lowering, tool_search discovery
   round, function/custom call-output replay, and a conservatively represented denial.
6. `metadata.json` (CAPTURED): client turn-metadata envelopes for turn, compaction,
   and continuation. Values synthetic; key sets and the compaction object are observed.
7. `sse-text-turn.json` (CAPTURED): the event sequence a loopback text turn must emit.
   The exact frame order with per-frame sequence numbers was accepted by real Codex
   0.158 during capture; our bridge emits the same contract.

## Scope notes (do not overgeneralize)

* Transport used `content-encoding: zstd` with JSON bodies; fixtures store plain JSON.
* The loopback provider class preserves the full `chatgpt-web/...` model selector as
   received by this bridge (bridge acceptance is tested). Bare-model normalization
   for other provider classes is out of scope here.
* Instruction rewriting beyond transport is provider/model-identity dependent and is
   not asserted by these fixtures.
* A denial arrives as a `function_call_output` whose output text reports the denial;
   the parser surfaces it as a non-error tool result (structural limitation, encoded
   in `tools.json` and asserted in tests, not hidden).
* Native `implementation: responses` (pre-turn text form) remains accepted alongside
   the captured routed `responses_compaction_v2` marker; both use strategy `memento`.
