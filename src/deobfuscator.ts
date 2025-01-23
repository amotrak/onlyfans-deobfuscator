import * as parser from "@babel/parser";
import traverse, { Binding, NodePath, Scope } from "@babel/traverse";
import * as t from "@babel/types";
import generate from "@babel/generator";
import beautify from "js-beautify";
import { readFileSync, writeFile } from "fs";
import vm from "vm";

const binop = ["+", "-", "/", "%", "*", "**", "&", "|", ">>", ">>>", "<<", "^", "==", "===", "!=", "!==", "in", "instanceof", ">", "<", ">=", "<=", "|>"] as const;
type BinaryOperator = (typeof binop)[number];
const isBinaryOperator = (x: any): x is BinaryOperator => binop.includes(x);

class ObfuscatedStrings {
    /**
        function e() {
            const W = [obfuscatedStrings...];
            return (e = function () {
                return W;
            })();
        }
     */
    static findStringsArray(path: NodePath<t.FunctionDeclaration>, vmContext: vm.Context): string | undefined {
        const node = path.node;
        const funcExpr = node.body.body;
        // no arguments
        if (node.params.length !== 0) return;
        // body should only have obfuscated strings declaration and return
        if (funcExpr.length !== 2 || !t.isVariableDeclaration(funcExpr[0])) return;

        // should only have array of obfuscated strings
        let declarations = (funcExpr[0] as t.VariableDeclaration).declarations;
        if (declarations.length !== 1) return;

        // should be initialized (non empty)
        let obfStrings = declarations[0];
        if (!t.isArrayExpression(obfStrings.init)) return;

        for (const elemNode of obfStrings.init.elements) {
            if (!t.isStringLiteral(elemNode)) return;
        }
        if (!node.id) {
            console.error("Obf function was found but its name undefined");
            return;
        }

        vm.runInContext(generate(node).code, vmContext);
        path.remove();
        return node.id.name;
    }

    /**
        function f(W, n) {
            const c = e();
            return (
            (f = function (n, o) {...}),
            f(W, n)
            );
        }
     */
    static findBaseDecryptFunction(path: NodePath<t.FunctionDeclaration>, vmContext: vm.Context, obfStringsFunc: string): string | undefined {
        const node = path.node;
        const funcExpr = node.body.body;
        if (node.params.length !== 2) return;
        
        if (funcExpr.length !== 2 || !t.isVariableDeclaration(funcExpr[0])) return;

        let declarations = (funcExpr[0] as t.VariableDeclaration).declarations;
        if (declarations.length !== 1) return;

        if (!t.isCallExpression(declarations[0].init)) return;
        if (!t.isIdentifier(declarations[0].init?.callee, {name: obfStringsFunc})) return;

        if (!node.id) {
            console.error("Decode string function was found but its name undefined");
            path.stop();
            return;
        }

        vm.runInContext(generate(node).code, vmContext);
        path.remove();
        return node.id.name;
    }

    /**
        function n(W, n) {                    <-------------------
            return f(W - 246, n);
            }
          return (
            (d[n(617, "oFxR")] = [
              n(547, "xnSq"),
              e,
              (function (W) {
                function o(W, c) {            <-------------------
                  return n(c - 483, W);
                }
     */
    static findDecryptFunction(
        path: NodePath<t.FunctionDeclaration>, vmContext: vm.Context,
        baseDecryptFunc: string): Binding | undefined {
            const node = path.node;
            const funcExpr = node.body.body;
            if (node.params.length !== 2 || funcExpr.length !== 1) return;
            if (!t.isReturnStatement(funcExpr[0]) || !funcExpr[0].argument) return;
            const call = funcExpr[0].argument as t.CallExpression;

            if (!t.isIdentifier(call.callee, {name: baseDecryptFunc})) return
            // if (!funcFirstDecode && !t.isIdentifier(node.id, {name: "c"})) return;

            if (!node.id) {
                console.error("Decode string function was found but its name undefined");
                path.stop();
                return;
            }
    
            vm.runInContext(generate(node).code, vmContext);
            const binding = path.parentPath.scope.getBinding(node.id.name);
            if (!binding) {
                console.error(`Decrypt function ${node.id.name} has no references`);
                path.stop();
                return;
            }

            path.remove();
            return binding;
    }

    /**
        !(function (W, n) {
            const c = W();
            function o(W, n) {
                return f(n - 434, W);
            }
            ...
        })(e, 928388)
     */
    static shuffleObfuscatedStrings(path: NodePath<t.CallExpression>, vmContext: vm.Context, funcObfStrings: string): boolean | undefined {
        const node = path.node;

        if (node.arguments.length !== 2) return;
        if (!t.isIdentifier(node.arguments[0], {name: funcObfStrings})) return;
        if (!t.isNumericLiteral(node.arguments[1])) return;
        const code = generate(t.expressionStatement(node)).code;
        
        vm.runInContext(code, vmContext);
        if (t.isUnaryExpression(path.parentPath.node)) {
            path.parentPath.remove()
        } else {
            path.remove();
        }
        return true;
    }
}

class DecryptStrings {
    /**
        n(665, "&)C5") -> getters.auth/authUserId
        o("u&1z", 1044) -> charCodeAt
     */
    static decryptMapKeys(decyptFuncBinding: Binding, vmContext: vm.Context) {
        const references = decyptFuncBinding.referencePaths;
        for (const reference of references) {
            const refParentPath = reference.parentPath;
            if (!refParentPath) continue;
            /**
                function o(W, c) {
                  return n(c - 483, W);
                }
             */
            if (t.isReturnStatement(refParentPath.parent)) continue;

            const code = generate(refParentPath.node).code;
            const value = vm.runInContext(code, vmContext);
            // console.log(`${code} -> ${value}`)
            refParentPath.replaceWith(t.valueToNode(value));
        }
    }
}

enum MapFuncType {
    CallOneArg,
    CallThreeArg,
}

class MapReplacer {
    decryptionMap: {
        [key: string]: BinaryOperator | MapFuncType | string,
    };
    mapName: string | undefined;
    scope: Scope | undefined;

    constructor() {
        this.decryptionMap = {};
    }

    /**
     * const c = {
              YwyJj: function (W, n) {
                return W + n;
              },
              xvxnp: function (W, n) {
                return W % n;
              },
              BTZuH: function (W, n) {
                return W - n;
              },
              
              aZicX: function (W, n, c, o) {
                return W(n, c, o);
              },
              htzgw: n(588, "**Ox"),
              tyrSs: n(578, "xnSq"),
              dOGlL: function (W, n) {
                return W(n);
              },
              BEYfJ: n(598, "PfIY"),
            }
     */
    public parseMap(path: NodePath<t.VariableDeclarator>): boolean | undefined {
        let node = path.node;
        if (!t.isObjectExpression(node.init)) return;
        if (!t.isIdentifier(node.id)) return;

        let flag = false;
        node.init.properties = node.init.properties.filter((elemNode) => {
            if (!t.isObjectProperty(elemNode)) return true;
            if (!t.isIdentifier(elemNode.key)) return true;
            const key = elemNode.key.name;

            // either one of
            // function(lhs, rhs) { lhs %-+ rhs }
            // function(inner, arg1, arg2, arg3) { inner(arg1, arg2, arg3) }
            // function(inner, arg1) { inner(arg1) }
            if (t.isFunctionExpression(elemNode.value)) {
                let funcBody = elemNode.value.body.body;
                if (funcBody.length !== 1) return true; // only one statement in function
                if (!t.isReturnStatement(funcBody[0])) return true; // only return expression
                const ret = funcBody[0].argument;

                if (t.isBinaryExpression(ret)) {
                    this.decryptionMap[key] = ret.operator;
                    flag = true; // should save map variable name and its scope
                } else if (t.isCallExpression(ret)) {
                    if (ret.arguments.length === 3) {
                        this.decryptionMap[key] = MapFuncType.CallThreeArg;
                    } else if (ret.arguments.length === 1) {
                        this.decryptionMap[key] = MapFuncType.CallOneArg;
                    }
                }
            } else if (t.isStringLiteral(elemNode.value)) {
                // tyrSs: "navigator.userAgent"
                // save static strings for futher replacements in code
                this.decryptionMap[key] = elemNode.value.value;
            } else {
                console.error(`Unknown value type occured in operations map: ${elemNode.value.type}`)
                return true;
            }
            return false;
        });
        
        if (flag) {
            this.mapName = node.id.name;
            this.scope = path.scope;
            return flag;
        }
    }

    /**
     * return Math.abs(c.YwyJj(c.yWlpb(...)))
     */
    public replaceBinaryOpCalls() {
        this.scope?.traverse(this.scope.path.node, {
            CallExpression(path: NodePath<t.CallExpression>) {
                const node = path.node;
                if (!t.isMemberExpression(node.callee)) return;

                const {object, property} = node.callee;
                if (!t.isIdentifier(object, {name: this.mapName})) return; // only if accessing functions in that map
                if (!t.isStringLiteral(property)) return;

                if (path.node.arguments.length !== 2) return; // only two arguments
                // replace function call with respected binary operation
                const op = this.decryptionMap[property.value];
                if (!isBinaryOperator(op)) return;
                let unObfNode = t.binaryExpression(op, node.arguments[0] as t.Expression, node.arguments[1] as t.Expression);
                path.replaceWith(unObfNode);
            }
        }, this);
    }

    public replaceMapIndexing() {
        if (!this.mapName) return;
        this.scope?.crawl(); // gather all references in this scope
        const references = this.scope?.getBinding(this.mapName)?.referencePaths;
        if (!references) {
            console.error("Map was found but has not been used further in the code")
            return;
        }
        for (const reference of references) {
            const mapIndex = reference.parentPath;
            const mapIndexParent = mapIndex?.parentPath;
            if (!mapIndex || !t.isMemberExpression(mapIndex.node)) continue;
            if (!mapIndexParent) continue;
            const mapIndexParentNode = mapIndexParent.node;

            const { object, computed, property } = mapIndex.node;

            if (object !== reference.node || !computed || !t.isStringLiteral(property)) {
                continue;
            }

            const mapVal = this.decryptionMap[property.value];

            // replace map indexing with string value
            if (typeof mapVal === 'string' && !isBinaryOperator(mapVal)) {
                mapIndex.replaceWith(t.valueToNode(mapVal));
            } else if (typeof mapVal !== 'string' && t.isCallExpression(mapIndexParentNode)) {
                // replace function wrappers
                // function(inner, arg1, arg2, arg3) { inner(arg1, arg2, arg3) }
                // function(inner, arg1) { inner(arg1) }
                if (mapIndexParentNode.arguments.length !== 0) {
                    const func = mapIndexParentNode.arguments[0] as t.Expression;
                    const args = mapIndexParentNode.arguments.slice(1);

                    mapIndexParentNode.callee = func;
                    mapIndexParentNode.arguments = args;
                }
            }
        }
    }
}

class SimplifyIndexing {
    static simplifyUnwrapOrElse(path: NodePath<t.CallExpression>) {
        // u is a decorator kinda `unwrapOrElse()(target, default)`,
        // which can be expressed in JS via ||
        const node = path.node;
        if (!t.isCallExpression(path.node.callee)) return;
        if (node.arguments.length !== 3) return;
        
        const args = node.arguments as t.Expression[];
        const object = args[0];
        const property = args[1];
        const elseExpr = args[2];

        const resultObj = this.simplifyMultiPropery(object, property);
        if (!resultObj) {
            console.error("Unhandled case when simplifing unwrapOrElse");
            return;
        }

        const op = t.logicalExpression("||", resultObj, elseExpr)
        path.replaceWith(op);
        path.skip();
    }

    private static simplifyMultiPropery(object: t.Expression, property: t.Expression): t.Expression | undefined {
        if (!t.isStringLiteral(property) || (t.isStringLiteral(property) && !property.value.includes("."))) {
            return t.memberExpression(object, property, true);
        } else {
            const properties = property.value.split(".");
            let resultObj;
            for (const prop of properties) {
                const propLit = t.stringLiteral(prop);
                if (!resultObj) {
                    resultObj = t.memberExpression(object, propLit, true);
                } else {
                    resultObj = t.memberExpression(resultObj, propLit, true);
                }
            }
            return resultObj;
        }
    }
}

/**
 * Main function to deobfuscate the code.
 * @param source The source code of the file to be deobfuscated
 *
 */
function deobfuscate(source: string) {
    //Parse AST of Source Code
    const ast = parser.parse(source);

    const decryptCtx = vm.createContext();

    let funcObfStrings: string | undefined;
    let baseDecryptFunc: string | undefined;
    let firstDecryptFuncBinding: Binding | undefined;
    let secondDecryptFuncBinding: Binding | undefined;
    let foundShuffleFunc: boolean | undefined;

    const findObfuscatedStrings = {
        FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
            let funcName = ObfuscatedStrings.findStringsArray(path, decryptCtx);
            if (funcName) {
                funcObfStrings = funcName;
                path.stop();
                return;
            }
        }
    };

    traverse(ast, findObfuscatedStrings);

    if (!funcObfStrings) {
        console.error("Strings was not found!")
        return;
    }

    const parseDecryptFunctions = {
        /**
        (n.A = (W) => {
          const c = {
              YwyJj: function (W, n) {
                return W + n;
              },
              ...
              htzgw: n(588, "**Ox"),
              ...
            }
          function n(W, n) {
            return f(W - 246, n);
            }
         */
        ArrowFunctionExpression(arrowFuncPath: NodePath<t.ArrowFunctionExpression>) {
            arrowFuncPath.traverse({
                FunctionDeclaration(path) {
                    if (!firstDecryptFuncBinding && baseDecryptFunc) {
                        const binding = ObfuscatedStrings.findDecryptFunction(path, decryptCtx, baseDecryptFunc);
                        if (binding) {
                            firstDecryptFuncBinding = binding;
                        }
                    } else if (!secondDecryptFuncBinding && firstDecryptFuncBinding) {
                        const binding = ObfuscatedStrings.findDecryptFunction(path, decryptCtx, firstDecryptFuncBinding.identifier.name);
                        if (binding) {
                            secondDecryptFuncBinding = binding;
                        }
                    }
                }
            })
        },

        FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
            if (funcObfStrings) {
                const funcName = ObfuscatedStrings.findBaseDecryptFunction(path, decryptCtx, funcObfStrings);

                if (funcName) {
                    baseDecryptFunc = funcName;
                    return;
                }
            }
        },

        CallExpression(path: NodePath<t.CallExpression>) {
            if (!funcObfStrings) return;

            if (ObfuscatedStrings.shuffleObfuscatedStrings(path, decryptCtx, funcObfStrings)) {
                foundShuffleFunc = true;
            }
        },
    };

    traverse(ast, parseDecryptFunctions);

    if (!baseDecryptFunc || !firstDecryptFuncBinding || !secondDecryptFuncBinding || !foundShuffleFunc) {
        console.error("Some decryption stuff was not found!")
        return;
    }

    DecryptStrings.decryptMapKeys(firstDecryptFuncBinding, decryptCtx);
    DecryptStrings.decryptMapKeys(secondDecryptFuncBinding, decryptCtx);

    const mapReplacer = new MapReplacer();

    const processMap = {
        VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
            const scope = mapReplacer.parseMap(path);
            if (!scope) return;

            mapReplacer.replaceBinaryOpCalls();

            mapReplacer.replaceMapIndexing();

            path.stop();
            path.remove();
        }
    };

    traverse(ast, processMap);

    const simplifyUnwrapOrElseExpr = {
        CallExpression(path: NodePath<t.CallExpression>) {
            // u is a decorator kinda `unwrapOrElse()(target, default)`,
            // which can be expressed in JS via ||
            SimplifyIndexing.simplifyUnwrapOrElse(path);
          },
    };

    traverse(ast, simplifyUnwrapOrElseExpr);

    const validIdentifierRegex = /^(?!(?:do|if|in|for|let|new|try|var|case|else|enum|eval|false|null|this|true|void|with|break|catch|class|const|super|throw|while|yield|delete|export|import|public|return|static|switch|typeof|default|extends|finally|package|private|continue|debugger|function|arguments|interface|protected|implements|instanceof)$)[$A-Z\_a-z]*$/;

    const bracketToDot = {
        MemberExpression(path: NodePath<t.MemberExpression>) {
            let { object, property, computed } = path.node;
            if (!computed) return; // Verify computed property is false
            if (!t.isStringLiteral(property)) return; // Verify property is a string literal
            if (!validIdentifierRegex.test(property.value)) return; // Verify that the property being accessed is a valid identifier

            // If conditions pass:

            // Replace the node with a new one
            path.replaceWith(
                t.memberExpression(object, t.identifier(property.value), false)
            );
        },
    };

    traverse(ast, bracketToDot);

    // Code Beautification
    let deobfCode = generate(ast, {
        comments: false
    }).code;
    deobfCode = beautify(deobfCode, {
        indent_size: 2,
        space_in_empty_paren: true,
    });

    writeCodeToFile(deobfCode);
}

function writeCodeToFile(code: string) {
    let outputPath = process.argv[3];
    writeFile(outputPath, code, (err) => {
        if (err) {
            console.error("Error writing file", err);
            return;
        }
        console.log(`Wrote file to ${outputPath}`);
    });
}

deobfuscate(readFileSync(process.argv[2], "utf8"));
