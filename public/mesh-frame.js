// Reading a packet hash out of whatever the user pasted.
//
// This module used to be much larger: it carried a MeshCore frame parser,
// a from-scratch SHA-256 and HMAC, and region decoding, because the browser
// fetched CoreScope directly and had to make sense of raw_hex itself. (The
// crypto was hand-rolled because SubtleCrypto is undefined outside a secure
// context, which any plain-http deployment is.)
//
// None of that belongs in a browser. The backend already had the same code
// in Go — internal/corescope's ParseFrame and RegionOfPacket — so /mesh-api/
// now serves the decoded scope, hash size, hop count and frame length as
// ordinary fields, and a backend that simply knows its own scopes (Beacon)
// never parses anything at all. What is left is genuinely a UI concern:
// turning user input into a hash to look up.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MeshFrame = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Accepts either a bare hash or a pasted link containing one — packet
  // hashes are consistently 16 hex characters in every real example
  // observed, so a straightforward regex over the whole input handles both
  // without needing to know any particular vendor's URL shape.
  function extractPacketHash(input) {
    const m = String(input).trim().match(/[0-9a-f]{16}/i);
    return m ? m[0].toLowerCase() : null;
  }

  return { extractPacketHash };
});
