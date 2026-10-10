package wanx

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"testing"
)

var regexpPlaceholder = regexp.MustCompile(`\{[^}]+\}`)

func TestAllCatalogRoutesAndDenyUnknown(t *testing.T) {
	var ops []Operation
	if err := json.Unmarshal(inventory, &ops); err != nil {
		t.Fatal(err)
	}
	ops = append(ops, managementOperations()...)
	policy := Policy{ApplicationID: "omnia-desktop", Agents: []string{"agent-1"}}
	for _, op := range ops {
		policy.Operations = append(policy.Operations, op.ID)
	}
	h := CatalogPolicy(policy)
	for _, op := range ops {
		path := regexpPlaceholder.ReplaceAllStringFunc(op.Path, func(part string) string {
			if part == "{agent_id}" {
				return "agent-1"
			}
			if part == "{file_path}" {
				return "dir/file.html"
			}
			return "resource-1"
		})
		if err := h.Authorize(op.Method, path); err != nil {
			t.Fatalf("%s %s: %v", op.Method, path, err)
		}
	}
	for _, path := range []string{"https://outside/api/agents", "/api/internal/private", "/api/agents/another/memory/atoms/1", "/api/agents/agent-1/../private"} {
		if h.Authorize("GET", path) == nil {
			t.Fatal("accepted", path)
		}
	}
	restricted := CatalogPolicy(Policy{Operations: []string{}})
	for _, op := range ops {
		for _, p := range op.Parameters {
			if p.In != "header" || !strings.EqualFold(p.Name, "X-Octop-Agent-Id") {
				continue
			}
			path := regexpPlaceholder.ReplaceAllString(op.Path, "resource-1")
			if h.AuthorizeRequest(op.Method, path, http.Header{"X-Octop-Agent-Id": {"agent-1"}}) != nil {
				t.Fatal("approved legacy agent denied")
			}
			if h.AuthorizeRequest(op.Method, path, http.Header{"X-Octop-Agent-Id": {"another"}}) == nil {
				t.Fatal("legacy agent bypassed policy")
			}
		}
	}
	if restricted.Authorize("GET", "/api/agents") == nil {
		t.Fatal("empty policy permitted operation")
	}
	if strings.Contains(SafeCode(errors.New("secret-url-token")), "secret") {
		t.Fatal("error leaked")
	}
}
