export const brainstormOperationRegistry = [
  {
    "operationId": "wanxBrainstormProfileGet",
    "method": "GET",
    "path": "/api/brainstorm/profile",
    "tags": [
      "brainstorm"
    ],
    "alias": "getProfile",
    "parameters": [],
    "bodyRequired": false,
    "contentTypes": [],
    "stream": "",
    "summary": "Native brainstorm: getProfile"
  },
  {
    "operationId": "wanxBrainstormProfileConfigure",
    "method": "POST",
    "path": "/api/brainstorm/profile",
    "tags": [
      "brainstorm"
    ],
    "alias": "configureProfile",
    "parameters": [],
    "bodyRequired": true,
    "contentTypes": [
      "application/json"
    ],
    "stream": "",
    "summary": "Native brainstorm: configureProfile"
  },
  {
    "operationId": "wanxBrainstormSessionsList",
    "method": "GET",
    "path": "/api/brainstorm/sessions",
    "tags": [
      "brainstorm"
    ],
    "alias": "listSessions",
    "parameters": [],
    "bodyRequired": false,
    "contentTypes": [],
    "stream": "",
    "summary": "Native brainstorm: listSessions"
  },
  {
    "operationId": "wanxBrainstormSessionsCreate",
    "method": "POST",
    "path": "/api/brainstorm/sessions",
    "tags": [
      "brainstorm"
    ],
    "alias": "createSession",
    "parameters": [],
    "bodyRequired": true,
    "contentTypes": [
      "application/json"
    ],
    "stream": "",
    "summary": "Native brainstorm: createSession"
  },
  {
    "operationId": "wanxBrainstormSessionGet",
    "method": "GET",
    "path": "/api/brainstorm/sessions/{thread_id}",
    "tags": [
      "brainstorm"
    ],
    "alias": "getSession",
    "parameters": [
      {
        "name": "thread_id",
        "in": "path",
        "required": true,
        "schema": {
          "type": "string"
        }
      }
    ],
    "bodyRequired": false,
    "contentTypes": [],
    "stream": "",
    "summary": "Native brainstorm: getSession"
  },
  {
    "operationId": "wanxBrainstormSessionControl",
    "method": "POST",
    "path": "/api/brainstorm/sessions/{thread_id}/control",
    "tags": [
      "brainstorm"
    ],
    "alias": "controlSession",
    "parameters": [
      {
        "name": "thread_id",
        "in": "path",
        "required": true,
        "schema": {
          "type": "string"
        }
      }
    ],
    "bodyRequired": true,
    "contentTypes": [
      "application/json"
    ],
    "stream": "",
    "summary": "Native brainstorm: controlSession"
  },
  {
    "operationId": "wanxBrainstormExpertImport",
    "method": "POST",
    "path": "/api/brainstorm/experts/{slug}/import",
    "tags": [
      "brainstorm"
    ],
    "alias": "importExpert",
    "parameters": [
      {
        "name": "slug",
        "in": "path",
        "required": true,
        "schema": {
          "type": "string"
        }
      }
    ],
    "bodyRequired": false,
    "contentTypes": [],
    "stream": "",
    "summary": "Import a SkillHub expert with WANX installer"
  },
{
  "operationId": "wanxBrainstormReportGet",
  "method": "GET",
  "path": "/api/brainstorm/sessions/{thread_id}/report",
  "tags": [
    "brainstorm"
  ],
  "alias": "getReport",
  "parameters": [
    {
      "name": "thread_id",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "bodyRequired": false,
  "contentTypes": [],
  "stream": "",
  "summary": "Read my final meeting report"
},
{
  "operationId": "wanxBrainstormReportDocument",
  "method": "GET",
  "path": "/api/brainstorm/sessions/{thread_id}/report/document",
  "tags": [
    "brainstorm"
  ],
  "alias": "exportReport",
  "parameters": [
    {
      "name": "thread_id",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "bodyRequired": false,
  "contentTypes": [],
  "stream": "",
  "summary": "Export my final report as Word"
}
] as const;
export const brainstormModuleRegistry = {
  "getProfile": "wanxBrainstormProfileGet",
  "configureProfile": "wanxBrainstormProfileConfigure",
  "listSessions": "wanxBrainstormSessionsList",
  "createSession": "wanxBrainstormSessionsCreate",
  "getSession": "wanxBrainstormSessionGet",
  "controlSession": "wanxBrainstormSessionControl",
  "importExpert": "wanxBrainstormExpertImport",
  "getReport": "wanxBrainstormReportGet",
  "exportReport": "wanxBrainstormReportDocument"
} as const;
