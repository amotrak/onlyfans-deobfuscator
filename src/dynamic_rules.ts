import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { readFileSync } from "fs";

/**
 {
  "end": "677cfb73",
  "start": "35244",
  "format": "35244:{}:{:x}:677cfb73",
  "prefix": "35244",
  "suffix": "677cfb73",
  "revision": "202501071000-d5ae7b6902",
  "app_token": "33d57ade8c02dbc5a333db99ff9ae26a",
  "static_param": "csx5vFQOGRDXx3z81ULA9WG69rjEjDJL",
  "remove_headers": [
    "user_id"
  ],
  "checksum_indexes": [],
  "checksum_constant": 356
}
 */

interface DynamicRules {
    end: string
    start: string
    format: string
    prefix: string
    suffix: string
    static_param: string
    remove_headers: string[]
    checksum_indexes: number[]
    checksum_constant: number
}

function getRules(ast: t.Node): DynamicRules | undefined {
    let staticParam: string | undefined;
    let checksumConstant: number = 0;
    let checksumIndexes: number[] = [];
    let prefix: string | undefined;
    let suffix: string | undefined;

    traverse(ast, {
        ArrayExpression(path) {
            const elements = path.node.elements;
            if (!t.isStringLiteral(elements[0])) return;
            const firstElem = elements[0].value;

            if (firstElem.length === 32) {
                staticParam = firstElem;
            } else if (!isNaN(parseInt(firstElem))) {
                prefix = firstElem;
            }

            const lastElem = elements.slice(-1)[0];
            if (t.isStringLiteral(lastElem) && !isNaN(parseInt(lastElem.value, 16))) {
                suffix = lastElem.value;
            }
        },

        BinaryExpression(path) {
            const node = path.node;
            if (t.isNumericLiteral(node.right)) {
                const right = node.right as t.NumericLiteral;
                if (node.operator === '+') {
                    checksumConstant += right.value;
                } else if (node.operator === '-') {
                    checksumConstant -= right.value;
                } else {
                    console.error("Unhandler operator: ", node.operator);
                }
            } else if (t.isNumericLiteral(node.left) && node.operator === "%") {
                const left = node.left as t.NumericLiteral;
                checksumIndexes.push(left.value % 40);
            }
        }
    });

    if (!prefix || !suffix || !staticParam) return;

    return {
        end: suffix,
        start: prefix,
        format: `${prefix}:{}:{:x}:${suffix}`,
        prefix,
        suffix,
        static_param: staticParam,
        remove_headers: [
          "user_id"
        ],
        checksum_indexes: checksumIndexes,
        checksum_constant: checksumConstant
    };
}

const ast = parser.parse(readFileSync(process.argv[2], "utf8"));
const rules = getRules(ast);
if (!rules) {
    process.exit(1);
}

console.log(JSON.stringify(rules))
