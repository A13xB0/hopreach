package geo

import "testing"

func TestParsePolygon(t *testing.T) {
	data := []byte(`{"type":"Polygon","coordinates":[[[0,0],[4,0],[4,4],[0,4],[0,0]]]}`)
	b, err := Parse(data)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if !b.Contains(2, 2) {
		t.Errorf("expected (2,2) inside the square")
	}
	if b.Contains(10, 10) {
		t.Errorf("expected (10,10) outside the square")
	}
}

func TestParseFeature(t *testing.T) {
	data := []byte(`{"type":"Feature","geometry":{"type":"MultiPolygon","coordinates":[[[[0,0],[4,0],[4,4],[0,4],[0,0]]]]}}`)
	b, err := Parse(data)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if !b.Contains(2, 2) {
		t.Errorf("expected (2,2) inside the polygon")
	}
}

func TestParseFeatureCollection(t *testing.T) {
	data := []byte(`{"type":"FeatureCollection","features":[
		{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[2,0],[2,2],[0,2],[0,0]]]}},
		{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[10,10],[12,10],[12,12],[10,12],[10,10]]]}}
	]}`)
	b, err := Parse(data)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if !b.Contains(1, 1) {
		t.Errorf("expected (1,1) inside the first feature")
	}
	if !b.Contains(11, 11) {
		t.Errorf("expected (11,11) inside the second feature")
	}
	if b.Contains(5, 5) {
		t.Errorf("expected (5,5) outside both features")
	}
}

func TestParseUnsupportedType(t *testing.T) {
	if _, err := Parse([]byte(`{"type":"LineString","coordinates":[[0,0],[1,1]]}`)); err == nil {
		t.Errorf("expected an error for an unsupported top-level type")
	}
}

func TestParseDefaultGeoJSON(t *testing.T) {
	b, err := Parse(DefaultGeoJSON)
	if err != nil {
		t.Fatalf("Parse(DefaultGeoJSON): %v", err)
	}
	if !b.Contains(55.9533, -3.1883) {
		t.Errorf("expected Edinburgh to be inside the default (Scotland) boundary")
	}
	if b.Contains(51.5072, -0.1276) {
		t.Errorf("expected London to be outside the default (Scotland) boundary")
	}
}
