//go:build js && wasm

// Meshsim's WASM bridge: unlike propagation/demgrid's hot-path,
// handle-based API above, this is called a handful of times per user
// interaction (run one simulation, run one settings search) — cheap enough
// to marshal a whole request/response as JSON rather than building a
// second handle registry. See public/meshsim-bridge.js for the JS-side
// wrapper.
package main

import (
	"encoding/json"
	"syscall/js"

	"hopreach/internal/meshsim"
)

// jsErrorResult builds the {error: string} shape meshsim-bridge.js checks
// for, so a malformed request surfaces as a normal JS-catchable value
// instead of a syscall/js panic breaking the whole WASM instance.
func jsErrorResult(err error) any {
	out, _ := json.Marshal(map[string]string{"error": err.Error()})
	return string(out)
}

// jsSimRun(requestJSON) -> resultJSON. requestJSON decodes to
// {scenario: Scenario, messages: []Message, seed: uint64, maxSimTimeMs: uint32};
// resultJSON encodes a meshsim.Report.
func jsSimRun(this js.Value, args []js.Value) any {
	var req struct {
		Scenario     meshsim.Scenario  `json:"scenario"`
		Messages     []meshsim.Message `json:"messages"`
		Seed         uint64            `json:"seed"`
		MaxSimTimeMs uint32            `json:"maxSimTimeMs"`
	}
	if err := json.Unmarshal([]byte(args[0].String()), &req); err != nil {
		return jsErrorResult(err)
	}

	rng := meshsim.NewSeededRNG(req.Seed)
	report := meshsim.Run(req.Scenario, req.Messages, rng, req.MaxSimTimeMs)

	out, err := json.Marshal(report)
	if err != nil {
		return jsErrorResult(err)
	}
	return string(out)
}

// jsSimSuggest(requestJSON[, onProgress]) -> resultJSON. requestJSON
// decodes directly to a meshsim.TuneRequest; resultJSON encodes a
// meshsim.TuneResult. onProgress, if given and callable, is invoked as
// onProgress(done, total) after the baseline and after every candidate —
// see meshsim.Suggest's own doc comment for why this exists at all (a real
// search is easily a hundred-plus candidates, each several simulation
// runs, and this call used to give zero feedback for its entire duration).
func jsSimSuggest(this js.Value, args []js.Value) any {
	var req meshsim.TuneRequest
	if err := json.Unmarshal([]byte(args[0].String()), &req); err != nil {
		return jsErrorResult(err)
	}

	var progress func(done, total int)
	if len(args) > 1 && args[1].Type() == js.TypeFunction {
		onProgress := args[1]
		progress = func(done, total int) {
			onProgress.Invoke(done, total)
		}
	}

	result := meshsim.Suggest(req, progress)

	out, err := json.Marshal(result)
	if err != nil {
		return jsErrorResult(err)
	}
	return string(out)
}

// jsSimStress(requestJSON[, onProgress]) -> resultJSON. requestJSON decodes
// directly to a meshsim.StressRequest; resultJSON encodes a
// meshsim.StressResult. onProgress, if given and callable, is invoked as
// onProgress(done, total) after each swept load level — same shape and
// same reason as jsSimSuggest's own progress callback.
func jsSimStress(this js.Value, args []js.Value) any {
	var req meshsim.StressRequest
	if err := json.Unmarshal([]byte(args[0].String()), &req); err != nil {
		return jsErrorResult(err)
	}

	var progress func(done, total int)
	if len(args) > 1 && args[1].Type() == js.TypeFunction {
		onProgress := args[1]
		progress = func(done, total int) {
			onProgress.Invoke(done, total)
		}
	}

	result := meshsim.StressTest(req, progress)

	out, err := json.Marshal(result)
	if err != nil {
		return jsErrorResult(err)
	}
	return string(out)
}

// jsSimSuggestPolicy(requestJSON[, onProgress]) -> resultJSON. requestJSON
// decodes directly to a meshsim.PolicyTuneRequest; resultJSON encodes a
// meshsim.PolicyTuneResult. onProgress works the same as jsSimSuggest's —
// see meshsim.SuggestPolicy's own doc comment for how this search differs
// from the older jsSimSuggest/meshsim.Suggest (item 15c).
func jsSimSuggestPolicy(this js.Value, args []js.Value) any {
	var req meshsim.PolicyTuneRequest
	if err := json.Unmarshal([]byte(args[0].String()), &req); err != nil {
		return jsErrorResult(err)
	}

	var progress func(done, total int)
	if len(args) > 1 && args[1].Type() == js.TypeFunction {
		onProgress := args[1]
		progress = func(done, total int) {
			onProgress.Invoke(done, total)
		}
	}

	result := meshsim.SuggestPolicy(req, progress)

	out, err := json.Marshal(result)
	if err != nil {
		return jsErrorResult(err)
	}
	return string(out)
}

// jsSimAssignPolicy(requestJSON) -> resultJSON. requestJSON decodes to
// {scenario: Scenario, attrs: []NodeAttrs (optional), policy: ConfigPolicy};
// resultJSON encodes a []meshsim.PolicyAssignment. Phase 4 work item 6's
// "which tier was this repeater labelled" query — deliberately exposed
// over WASM rather than reimplemented in JS (see meshsim.AssignPolicy's
// own doc comment on why matched-rule attribution needs to agree with the
// engine exactly, not just approximately).
func jsSimAssignPolicy(this js.Value, args []js.Value) any {
	var req struct {
		Scenario meshsim.Scenario     `json:"scenario"`
		Attrs    []meshsim.NodeAttrs  `json:"attrs,omitempty"`
		Policy   meshsim.ConfigPolicy `json:"policy"`
	}
	if err := json.Unmarshal([]byte(args[0].String()), &req); err != nil {
		return jsErrorResult(err)
	}

	assignments := meshsim.AssignPolicy(req.Scenario, req.Attrs, req.Policy)

	out, err := json.Marshal(assignments)
	if err != nil {
		return jsErrorResult(err)
	}
	return string(out)
}

// jsSimMeshMethods(): no arguments; returns the JSON-encoded
// []meshsim.MeshMethod catalogue (phase 4 work item 5) — Name/Policy/
// Source/AsOf/Direction/Note for every built-in community method, so the
// UI can show a policy search suggestion's real-world provenance (Source
// is mandatory on every entry — see MeshMethod's own doc comment) rather
// than hand-copying this catalogue into JS a second time.
func jsSimMeshMethods(this js.Value, args []js.Value) any {
	out, err := json.Marshal(meshsim.BuiltinMeshMethods())
	if err != nil {
		return jsErrorResult(err)
	}
	return string(out)
}

// jsSimOptimizeStep(requestJSON) -> resultJSON. requestJSON decodes to
// {request: OptimizeRequest, state: OptimizeState} (state omitted or {}
// for a fresh start — see meshsim.OptimizeState.Initialized); resultJSON
// encodes the resulting OptimizeState. Both fields travel in one combined
// object, matching every other meshsim WASM call's own "one JSON blob per
// call" convention (see jsSimRun) rather than a second positional
// argument meshsim-bridge.js's own call() helper doesn't support.
//
// Deliberately ONE bounded step per call, not a loop to completion — see
// meshsim.OptimizeStep's own doc comment on why: a single call that
// searched to completion could never be cancelled, since `self.onmessage`
// can't fire while a synchronous WASM call is running. The caller
// (public/simulator.js) drives the whole optimization by calling this
// repeatedly via public/meshsim-worker.js's own "optimize-step" message
// kind, one round-trip per round, which is what actually gives the
// worker's event loop a real chance to notice a cancel between rounds.
func jsSimOptimizeStep(this js.Value, args []js.Value) any {
	var req struct {
		Request meshsim.OptimizeRequest `json:"request"`
		State   meshsim.OptimizeState   `json:"state"`
	}
	if err := json.Unmarshal([]byte(args[0].String()), &req); err != nil {
		return jsErrorResult(err)
	}

	result := meshsim.OptimizeStep(req.Request, req.State)

	out, err := json.Marshal(result)
	if err != nil {
		return jsErrorResult(err)
	}
	return string(out)
}

// jsSimOptimizeValidate(requestJSON) -> resultJSON. requestJSON decodes to
// {request: OptimizeRequest, policy: ConfigPolicy} (only HoldoutSeed/
// HoldoutTrials/Scenario/Messages/MaxSimTimeMs/Attrs are actually read
// from request); resultJSON encodes {delivery, collision}. Called once
// after OptimizeStep-driven iteration stops — see meshsim.
// OptimizeValidate's own doc comment on why this is a separate call, not
// part of the chunked loop.
func jsSimOptimizeValidate(this js.Value, args []js.Value) any {
	var req struct {
		Request meshsim.OptimizeRequest `json:"request"`
		Policy  meshsim.ConfigPolicy    `json:"policy"`
	}
	if err := json.Unmarshal([]byte(args[0].String()), &req); err != nil {
		return jsErrorResult(err)
	}

	delivery, collision := meshsim.OptimizeValidate(req.Request, req.Policy)

	out, err := json.Marshal(map[string]float64{"delivery": delivery, "collision": collision})
	if err != nil {
		return jsErrorResult(err)
	}
	return string(out)
}

func registerMeshsim(api js.Value) {
	api.Set("simRun", js.FuncOf(jsSimRun))
	api.Set("simSuggest", js.FuncOf(jsSimSuggest))
	api.Set("simStress", js.FuncOf(jsSimStress))
	api.Set("simSuggestPolicy", js.FuncOf(jsSimSuggestPolicy))
	api.Set("simAssignPolicy", js.FuncOf(jsSimAssignPolicy))
	api.Set("simMeshMethods", js.FuncOf(jsSimMeshMethods))
	api.Set("simOptimizeStep", js.FuncOf(jsSimOptimizeStep))
	api.Set("simOptimizeValidate", js.FuncOf(jsSimOptimizeValidate))
}
