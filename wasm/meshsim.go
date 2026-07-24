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

func registerMeshsim(api js.Value) {
	api.Set("simRun", js.FuncOf(jsSimRun))
	api.Set("simSuggest", js.FuncOf(jsSimSuggest))
}
