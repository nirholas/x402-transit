/**
 * Per-route request/response contracts published inside the x402 402 challenge.
 *
 * GENERATED FROM `public/openapi.json` — do not hand-edit. Run `npm run schemas`
 * after changing the OpenAPI document so the runtime challenge and the published
 * metadata cannot drift apart.
 *
 * The x402scan discovery spec requires every `accepts[]` entry to carry
 * `outputSchema.input` and `outputSchema.output`. Together they are how an agent
 * calls a route it has never seen before: `input` describes the request in the
 * x402 Bazaar `type: "http"` shape, and `output` is the JSON Schema of the 200
 * body the agent receives once it has paid. All `$ref`s are inlined, since a
 * client reading the challenge has not fetched the OpenAPI document.
 *
 * Keys match the paywall route map exactly:
 *   GET /plan
 *   GET /delays
 */

/**
 * One paid route's published request/response contract.
 *
 * Declared as a type alias rather than an interface so that it keeps an
 * implicit index signature and stays assignable to the paywall's
 * `outputSchema?: Record<string, unknown>`.
 */
export type RouteSchema = {
  /** How to call the route: method, path/query parameters or JSON body fields. */
  input: Record<string, unknown>;
  /** JSON Schema of the 200 response body. */
  output: Record<string, unknown>;
};

export const ROUTE_SCHEMAS: Record<string, RouteSchema> = {
  "GET /plan": {
    "input": {
      "type": "http",
      "method": "GET",
      "queryParams": {
        "from": {
          "type": "string",
          "description": "Required. Stop id (place-sstat), station name, or \"lat,lon\""
        },
        "to": {
          "type": "string",
          "description": "Required. Same forms as from"
        },
        "departAfter": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601; defaults to now"
        },
        "max": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10,
          "default": 3
        }
      }
    },
    "output": {
      "type": "object",
      "properties": {
        "source": {
          "const": "gtfs-live"
        },
        "agency": {
          "type": "string"
        },
        "feed": {
          "type": "string"
        },
        "query": {
          "type": "object"
        },
        "itineraries": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "kind": {
                "enum": [
                  "direct",
                  "one-transfer"
                ]
              },
              "departure": {
                "type": [
                  "string",
                  "null"
                ],
                "format": "date-time"
              },
              "arrival": {
                "type": [
                  "string",
                  "null"
                ],
                "format": "date-time"
              },
              "durationMinutes": {
                "type": [
                  "integer",
                  "null"
                ]
              },
              "transfers": {
                "type": "integer"
              },
              "legs": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "routeId": {
                      "type": "string"
                    },
                    "routeName": {
                      "type": "string"
                    },
                    "routeType": {
                      "type": "string",
                      "description": "subway | light-rail | commuter-rail | bus | ferry | transit"
                    },
                    "headsign": {
                      "type": "string"
                    },
                    "tripId": {
                      "type": "string"
                    },
                    "from": {
                      "type": "object",
                      "properties": {
                        "stopId": {
                          "type": "string"
                        },
                        "name": {
                          "type": "string"
                        },
                        "scheduledDeparture": {
                          "type": [
                            "string",
                            "null"
                          ],
                          "format": "date-time"
                        },
                        "predictedDeparture": {
                          "type": [
                            "string",
                            "null"
                          ],
                          "format": "date-time"
                        }
                      }
                    },
                    "to": {
                      "type": "object",
                      "properties": {
                        "stopId": {
                          "type": "string"
                        },
                        "name": {
                          "type": "string"
                        },
                        "scheduledArrival": {
                          "type": [
                            "string",
                            "null"
                          ],
                          "format": "date-time"
                        },
                        "predictedArrival": {
                          "type": [
                            "string",
                            "null"
                          ],
                          "format": "date-time"
                        }
                      }
                    },
                    "durationMinutes": {
                      "type": [
                        "integer",
                        "null"
                      ]
                    },
                    "realtime": {
                      "type": "boolean",
                      "description": "true when the realtime feed had an update for this trip"
                    }
                  }
                }
              }
            },
            "required": [
              "kind",
              "legs",
              "transfers"
            ]
          }
        },
        "note": {
          "type": "string"
        },
        "retrievedAt": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "source",
        "itineraries",
        "retrievedAt"
      ]
    }
  },
  "GET /delays": {
    "input": {
      "type": "http",
      "method": "GET",
      "queryParams": {
        "stop": {
          "type": "string",
          "description": "Required. Stop id, station name, or \"lat,lon\""
        },
        "route": {
          "type": "string",
          "description": "Optional routeId filter"
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100,
          "default": 20
        }
      }
    },
    "output": {
      "type": "object",
      "properties": {
        "source": {
          "const": "gtfs-rt-live"
        },
        "agency": {
          "type": "string"
        },
        "feed": {
          "type": "string"
        },
        "query": {
          "type": "object"
        },
        "summary": {
          "type": "object",
          "properties": {
            "predictions": {
              "type": "integer"
            },
            "withSchedule": {
              "type": "integer"
            },
            "onTime": {
              "type": "integer"
            },
            "late": {
              "type": "integer"
            },
            "early": {
              "type": "integer"
            },
            "medianDelaySeconds": {
              "type": [
                "integer",
                "null"
              ]
            },
            "worstDelaySeconds": {
              "type": [
                "integer",
                "null"
              ]
            },
            "verdict": {
              "enum": [
                "no-data",
                "running-well",
                "minor-delays",
                "significant-delays"
              ]
            }
          }
        },
        "arrivals": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "routeId": {
                "type": "string"
              },
              "routeName": {
                "type": "string"
              },
              "tripId": {
                "type": "string"
              },
              "headsign": {
                "type": "string"
              },
              "directionId": {
                "type": "integer"
              },
              "stopId": {
                "type": "string"
              },
              "scheduled": {
                "type": [
                  "string",
                  "null"
                ],
                "format": "date-time"
              },
              "predicted": {
                "type": [
                  "string",
                  "null"
                ],
                "format": "date-time"
              },
              "delaySeconds": {
                "type": [
                  "integer",
                  "null"
                ]
              },
              "delayMinutes": {
                "type": [
                  "integer",
                  "null"
                ]
              },
              "status": {
                "enum": [
                  "early",
                  "on-time",
                  "late",
                  "unknown"
                ]
              },
              "uncertaintySeconds": {
                "type": [
                  "integer",
                  "null"
                ]
              }
            }
          }
        },
        "note": {
          "type": "string"
        },
        "retrievedAt": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "source",
        "summary",
        "arrivals",
        "retrievedAt"
      ]
    }
  }
};
