package meshsim

// NodePrefs mirrors MeshCore's own per-node CLI-configurable preferences
// exactly — same names (as comments), same units, same defaults and valid
// ranges as the real `set txdelay`/`set direct.txdelay`/`set rxdelay`/
// `set tx` commands — specifically so a value this simulator suggests can
// be pasted straight into a real device's CLI without any unit or naming
// translation.
type NodePrefs struct {
	// TxDelayFactor: `set txdelay <value>` — scales the random flood-relay
	// delay window (see RetransmitDelayMs). Range 0-2, default 0.5.
	TxDelayFactor float64 `json:"txDelayFactor"`
	// DirectTxDelayFactor: `set direct.txdelay <value>` — same, for direct
	// (routed, non-flood) traffic. Range 0-2, default 0.3 (verified against
	// current source; some secondhand descriptions say 0.2, an older
	// default).
	DirectTxDelayFactor float64 `json:"directTxDelayFactor"`
	// RxDelayBase: `set rxdelay <value>` — weak-signal RX holdback (see
	// RxDelayMs). Range 0-20, default 0 (off).
	RxDelayBase float64 `json:"rxDelayBase"`
	// TxPowerDBm: `set tx <dbm>`. Range 1-22 (verified from the CLI
	// reference); the real firmware's own default specific value isn't yet
	// confirmed against source — DefaultNodePrefs uses the range maximum as
	// a placeholder until that's checked.
	TxPowerDBm float64 `json:"txPowerDbm"`

	Radio LoRaParams `json:"radio"`
}

// DefaultNodePrefs mirrors MeshCore's own current firmware defaults
// (examples/simple_repeater/MyMesh.cpp's begin()): rx_delay_base=0.0 (off),
// tx_delay_factor=0.5, direct_tx_delay_factor=0.3.
func DefaultNodePrefs() NodePrefs {
	return NodePrefs{
		TxDelayFactor:       0.5,
		DirectTxDelayFactor: 0.3,
		RxDelayBase:         0,
		TxPowerDBm:          22,
		Radio:               DefaultLoRaParams(),
	}
}
