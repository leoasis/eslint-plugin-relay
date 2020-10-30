/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const path = require('path');
const utils = require('./utils');
const shouldLint = utils.shouldLint;
const getGraphQLAST = utils.getGraphQLAST;

const DEFAULT_FLOW_TYPES_OPTIONS = {
  fix: false,
  haste: false
};

function getOptions(optionValue) {
  if (optionValue) {
    return {
      fix: optionValue.fix || DEFAULT_FLOW_TYPES_OPTIONS.fix,
      haste: optionValue.haste || DEFAULT_FLOW_TYPES_OPTIONS.haste,
      artifactDirectory: optionValue.artifactDirectory
    };
  }
  return DEFAULT_FLOW_TYPES_OPTIONS;
}

function getTypeImportName(node) {
  return (node.specifiers[0].local || node.specifiers[0].imported).name;
}

function genImportFixRange(type, imports, requires) {
  const typeImports = imports.filter(node => node.importKind === 'type');
  const alreadyHasImport = typeImports.some(node =>
    node.specifiers.some(
      specifier => (specifier.imported || specifier.local).name === type
    )
  );

  if (alreadyHasImport) {
    return null;
  }
  if (typeImports.length > 0) {
    let precedingImportIndex = 0;
    while (
      typeImports[precedingImportIndex + 1] &&
      getTypeImportName(typeImports[precedingImportIndex + 1]) < type
    ) {
      precedingImportIndex++;
    }
    return typeImports[precedingImportIndex].range;
  }
  if (imports.length > 0) {
    return imports[imports.length - 1].range;
  }
  if (requires.length > 0) {
    return requires[requires.length - 1].range;
  }
  // start of file
  return [0, 0];
}

function genImportFixer(
  fixer,
  importFixRange,
  type,
  options,
  filename,
  whitespace
) {
  if (!importFixRange) {
    // HACK: insert nothing
    return fixer.replaceTextRange([0, 0], '');
  }
  if (options.haste) {
    return fixer.insertTextAfterRange(
      importFixRange,
      `\n${whitespace}import type {${type}} from '${type}.graphql'`
    );
  } else {
    const generatedDir = options.artifactDirectory
      ? path.relative(path.dirname(filename), options.artifactDirectory)
      : './__generated__';
    return fixer.insertTextAfterRange(
      importFixRange,
      `\n${whitespace}import type {${type}} from '${generatedDir}/${type}.graphql'`
    );
  }
}

function getPropTypeProperty(
  context,
  typeAliasMap,
  propType,
  propName,
  visitedProps = new Set()
) {
  if (propType == null || visitedProps.has(propType)) {
    return null;
  }
  visitedProps.add(propType);
  const spreadsToVisit = [];
  if (propType.type === 'GenericTypeAnnotation') {
    return getPropTypeProperty(
      context,
      typeAliasMap,
      extractReadOnlyType(resolveTypeAlias(propType, typeAliasMap)),
      propName,
      visitedProps
    );
  }
  if (propType.type !== 'ObjectTypeAnnotation') {
    return null;
  }
  for (const property of propType.properties) {
    if (property.type === 'ObjectTypeSpreadProperty') {
      spreadsToVisit.push(property);
    } else {
      // HACK: Type annotations don't currently expose a 'key' property:
      // https://github.com/babel/babel-eslint/issues/307

      let tokenIndex = 0;
      if (property.static) {
        tokenIndex++;
      }
      if (property.variance) {
        tokenIndex++;
      }

      if (
        context.getSourceCode().getFirstToken(property, tokenIndex).value ===
        propName
      ) {
        return property;
      }
    }
  }
  for (const property of spreadsToVisit) {
    if (
      property.argument &&
      property.argument.id &&
      property.argument.id.name
    ) {
      const nextPropType = typeAliasMap[property.argument.id.name];
      const result = getPropTypeProperty(
        context,
        typeAliasMap,
        nextPropType,
        propName,
        visitedProps
      );
      if (result) {
        return result;
      }
    }
  }
  return null;
}

function validateObjectTypeAnnotation(
  context,
  options,
  Component,
  type,
  propName,
  propType,
  importFixRange,
  typeAliasMap,
  onlyVerify
) {
  const propTypeProperty = getPropTypeProperty(
    context,
    typeAliasMap,
    propType,
    propName
  );

  const atleastOnePropertyExists = !!propType.properties[0];

  if (!propTypeProperty) {
    if (onlyVerify) {
      return false;
    }
    context.report({
      message:
        '`{{prop}}` is not declared in the `props` of the React component or it is not marked with the ' +
        'generated flow type `{{type}}`. See ' +
        'https://facebook.github.io/relay/docs/en/graphql-in-relay.html#importing-generated-definitions',
      data: {
        prop: propName,
        type
      },
      fix: options.fix
        ? fixer => {
            const declaration =
              Component.parent.type === 'VariableDeclarator'
                ? Component.parent.parent
                : Component.parent;

            const whitespace = ' '.repeat(declaration.loc.start.column);

            const fixes = [
              genImportFixer(
                fixer,
                importFixRange,
                type,
                options,
                context.getFilename(),
                whitespace
              )
            ];
            if (atleastOnePropertyExists) {
              fixes.push(
                fixer.insertTextBefore(
                  propType.properties[0],
                  `${propName}: ${type}, `
                )
              );
            } else {
              fixes.push(fixer.replaceText(propType, `{${propName}: ${type}}`));
            }
            return fixes;
          }
        : null,
      loc: Component.loc
    });
    return false;
  }
  if (
    propTypeProperty.value.type === 'NullableTypeAnnotation' &&
    propTypeProperty.value.typeAnnotation.type === 'GenericTypeAnnotation' &&
    propTypeProperty.value.typeAnnotation.id.name === type
  ) {
    return true;
  }
  if (
    propTypeProperty.value.type !== 'GenericTypeAnnotation' ||
    propTypeProperty.value.id.name !== type
  ) {
    if (onlyVerify) {
      return false;
    }
    context.report({
      message:
        'Component property `{{prop}}` expects to use the generated ' +
        '`{{type}}` flow type. See https://facebook.github.io/relay/docs/en/graphql-in-relay.html#importing-generated-definitions',
      data: {
        prop: propName,
        type
      },
      fix: options.fix
        ? fixer => {
            const declaration =
              Component.parent.type === 'VariableDeclarator'
                ? Component.parent.parent
                : Component.parent;

            const whitespace = ' '.repeat(declaration.loc.start.column);
            return [
              genImportFixer(
                fixer,
                importFixRange,
                type,
                options,
                context.getFilename(),
                whitespace
              ),
              fixer.replaceText(propTypeProperty.value, type)
            ];
          }
        : null,
      loc: Component.loc
    });
    return false;
  }
  return true;
}

function extractReadOnlyType(genericType) {
  let currentType = genericType;
  while (
    currentType != null &&
    currentType.type === 'GenericTypeAnnotation' &&
    currentType.id.name === '$ReadOnly' &&
    currentType.typeParameters &&
    currentType.typeParameters.type === 'TypeParameterInstantiation' &&
    Array.isArray(currentType.typeParameters.params) &&
    currentType.typeParameters.params.length === 1
  ) {
    currentType = currentType.typeParameters.params[0];
  }
  return currentType;
}

function resolveTypeAlias(genericType, typeAliasMap) {
  let currentType = genericType;
  while (
    currentType != null &&
    currentType.type === 'GenericTypeAnnotation' &&
    typeAliasMap[currentType.id.name] != null
  ) {
    currentType = typeAliasMap[currentType.id.name];
  }
  return currentType;
}

module.exports = {
  meta: {
    fixable: 'code',
    docs: {
      description: 'Validates usage of RelayModern generated flow types'
    },
    schema: [
      {
        type: 'object',
        properties: {
          fix: {
            type: 'boolean'
          },
          haste: {
            type: 'boolean'
          },
          artifactDirectory: {
            type: 'string'
          }
        },
        additionalProperties: false
      }
    ]
  },
  create(context) {
    if (!shouldLint(context)) {
      return {};
    }
    const options = getOptions(context.options[0]);
    if (
      options.artifactDirectory &&
      !path.isAbsolute(options.artifactDirectory)
    ) {
      options.artifactDirectory = path.resolve(
        context.getCwd(),
        options.artifactDirectory
      );
    }
    const componentMap = {};
    const expectedTypes = [];
    const imports = [];
    const requires = [];
    const typeAliasMap = {};
    const useFragmentInstances = [];

    /**
     * Tries to find a GraphQL definition node for a given argument.
     * Supports a graphql`...` literal inline and follows variable definitions.
     */
    function getDefinition(arg) {
      if (arg == null) {
        return null;
      }
      if (arg.type === 'Identifier') {
        const name = arg.name;
        let scope = context.getScope();
        while (scope && scope.type != 'global') {
          for (const variable of scope.variables) {
            if (variable.name === name) {
              const definition = variable.defs.find(
                def => def.node && def.node.type === 'VariableDeclarator'
              );
              return definition ? getDefinition(definition.node.init) : null;
            }
          }
          scope = scope.upper;
        }
        return null;
      }
      if (arg.type !== 'TaggedTemplateExpression') {
        return null;
      }
      return getGraphQLAST(arg);
    }

    function getDefinitionName(arg) {
      const ast = getDefinition(arg);
      if (ast == null || ast.definitions.length === 0) {
        return null;
      }
      return ast.definitions[0].name.value;
    }

    function getRefetchableQueryName(arg) {
      const ast = getDefinition(arg);
      if (ast == null || ast.definitions.length === 0) {
        return null;
      }
      const refetchable = ast.definitions[0].directives.find(
        d => d.name.value === 'refetchable'
      );
      if (!refetchable) {
        return null;
      }
      const nameArg = refetchable.arguments.find(
        a => a.name.value === 'queryName'
      );
      return nameArg && nameArg.value && nameArg.value.value
        ? nameArg.value.value
        : null;
    }

    function trackHookCall(node, hookName) {
      const firstArg = node.arguments[0];
      if (firstArg == null) {
        return;
      }
      const fragmentName = getDefinitionName(firstArg);
      if (fragmentName == null) {
        return;
      }
      useFragmentInstances.push({
        fragmentName: fragmentName,
        node: node,
        hookName: hookName
      });
    }

    function createTypeImportFixer(node, operationName, typeText) {
      return fixer => {
        const importFixRange = genImportFixRange(
          operationName,
          imports,
          requires
        );
        return [
          genImportFixer(
            fixer,
            importFixRange,
            operationName,
            options,
            context.getFilename(),
            ''
          ),
          fixer.insertTextAfter(node.callee, `<${typeText}>`)
        ];
      };
    }

    function reportAndFixRefetchableType(node, hookName, defaultQueryName) {
      const queryName = getRefetchableQueryName(node.arguments[0]);
      context.report({
        node: node,
        message: `The \`${hookName}\` hook should be used with an explicit generated Flow type, e.g.: ${hookName}<{{queryName}}, _>(...)`,
        data: {
          queryName: queryName || defaultQueryName
        },
        fix:
          queryName != null && options.fix
            ? createTypeImportFixer(node, queryName, `${queryName}, _`)
            : null
      });
    }

    return {
      ImportDeclaration(node) {
        imports.push(node);
      },
      VariableDeclarator(node) {
        if (
          node.init &&
          node.init.type === 'CallExpression' &&
          node.init.callee.name === 'require'
        ) {
          requires.push(node);
        }

        if (node.init.type === 'ArrowFunctionExpression') {
          const componentName = node.id.name;
          componentMap[componentName] = {
            Component: node.id
          };
          const params = node.init.params;
          if (params.length > 0 && params[0].typeAnnotation) {
            const propType = params[0].typeAnnotation.typeAnnotation;
            if (propType) {
              componentMap[componentName].propType = propType;
            }
          }
        }
      },
      TypeAlias(node) {
        typeAliasMap[node.id.name] = node.right;
      },

      /**
       * Find useQuery() calls without type arguments.
       */
      'CallExpression[callee.name=useQuery]:not([typeArguments])'(node) {
        const firstArg = node.arguments[0];
        if (firstArg == null) {
          return;
        }
        const queryName = getDefinitionName(firstArg);
        context.report({
          node: node,
          message:
            'The `useQuery` hook should be used with an explicit generated Flow type, e.g.: useQuery<{{queryName}}>(...)',
          data: {
            queryName: queryName || 'ExampleQuery'
          },
          fix:
            queryName != null && options.fix
              ? createTypeImportFixer(node, queryName, queryName)
              : null
        });
      },

      /**
       * Find useLazyLoadQuery() calls without type arguments.
       */
      'CallExpression[callee.name=useLazyLoadQuery]:not([typeArguments])'(
        node
      ) {
        const firstArg = node.arguments[0];
        if (firstArg == null) {
          return;
        }
        const queryName = getDefinitionName(firstArg);
        context.report({
          node: node,
          message:
            'The `useLazyLoadQuery` hook should be used with an explicit generated Flow type, e.g.: useLazyLoadQuery<{{queryName}}>(...)',
          data: {
            queryName: queryName || 'ExampleQuery'
          },
          fix:
            queryName != null && options.fix
              ? createTypeImportFixer(node, queryName, queryName)
              : null
        });
      },

      /**
       * Find commitMutation() calls without type arguments.
       */
      'CallExpression[callee.name=commitMutation]:not([typeArguments])'(node) {
        // Get mutation config. It should be second argument of the `commitMutation`
        const mutationConfig = node.arguments && node.arguments[1];
        if (
          mutationConfig == null ||
          mutationConfig.type !== 'ObjectExpression'
        ) {
          return;
        }
        // Find `mutation` property on the `mutationConfig`
        const mutationNameProperty = mutationConfig.properties.find(
          prop => prop.key != null && prop.key.name === 'mutation'
        );
        if (
          mutationNameProperty == null ||
          mutationNameProperty.value == null
        ) {
          return;
        }
        const mutationName = getDefinitionName(mutationNameProperty.value);
        context.report({
          node: node,
          message:
            'The `commitMutation` must be used with an explicit generated Flow type, e.g.: commitMutation<{{mutationName}}>(...)',
          data: {
            mutationName: mutationName || 'ExampleMutation'
          },
          fix:
            mutationName != null && options.fix
              ? createTypeImportFixer(node, mutationName, mutationName)
              : null
        });
      },

      /**
       * Find requestSubscription() calls without type arguments.
       */
      'CallExpression[callee.name=requestSubscription]:not([typeArguments])'(
        node
      ) {
        const subscriptionConfig = node.arguments && node.arguments[1];
        if (
          subscriptionConfig == null ||
          subscriptionConfig.type !== 'ObjectExpression'
        ) {
          return;
        }
        const subscriptionNameProperty = subscriptionConfig.properties.find(
          prop => prop.key != null && prop.key.name === 'subscription'
        );

        if (
          subscriptionNameProperty == null ||
          subscriptionNameProperty.value == null
        ) {
          return;
        }
        const subscriptionName = getDefinitionName(
          subscriptionNameProperty.value
        );
        context.report({
          node: node,
          message:
            'The `requestSubscription` must be used with an explicit generated Flow type, e.g.: requestSubscription<{{subscriptionName}}>(...)',
          data: {
            subscriptionName: subscriptionName || 'ExampleSubscription'
          },
          fix:
            subscriptionName != null && options.fix
              ? createTypeImportFixer(node, subscriptionName, subscriptionName)
              : null
        });
      },

      /**
       * Find usePaginationFragment() calls without type arguments.
       */
      'CallExpression[callee.name=usePaginationFragment]:not([typeArguments])'(
        node
      ) {
        reportAndFixRefetchableType(
          node,
          'usePaginationFragment',
          'PaginationQuery'
        );
      },

      /**
       * Find useBlockingPaginationFragment() calls without type arguments.
       */
      'CallExpression[callee.name=useBlockingPaginationFragment]:not([typeArguments])'(
        node
      ) {
        reportAndFixRefetchableType(
          node,
          'useBlockingPaginationFragment',
          'PaginationQuery'
        );
      },

      /**
       * Find useLegacyPaginationFragment() calls without type arguments.
       */
      'CallExpression[callee.name=useLegacyPaginationFragment]:not([typeArguments])'(
        node
      ) {
        reportAndFixRefetchableType(
          node,
          'useLegacyPaginationFragment',
          'PaginationQuery'
        );
      },

      /**
       * Find useRefetchableFragment() calls without type arguments.
       */
      'CallExpression[callee.name=useRefetchableFragment]:not([typeArguments])'(
        node
      ) {
        reportAndFixRefetchableType(
          node,
          'useRefetchableFragment',
          'RefetchableQuery'
        );
      },

      /**
       * useFragment() calls
       */
      'CallExpression[callee.name=useFragment]'(node) {
        trackHookCall(node, 'useFragment');
      },

      /**
       * usePaginationFragment() calls
       */
      'CallExpression[callee.name=usePaginationFragment]'(node) {
        trackHookCall(node, 'usePaginationFragment');
      },

      /**
       * useBlockingPaginationFragment() calls
       */
      'CallExpression[callee.name=useBlockingPaginationFragment]'(node) {
        trackHookCall(node, 'useBlockingPaginationFragment');
      },

      /**
       * useLegacyPaginationFragment() calls
       */
      'CallExpression[callee.name=useLegacyPaginationFragment]'(node) {
        trackHookCall(node, 'useLegacyPaginationFragment');
      },

      /**
       * useRefetchableFragment() calls
       */
      'CallExpression[callee.name=useRefetchableFragment]'(node) {
        trackHookCall(node, 'useRefetchableFragment');
      },

      ClassDeclaration(node) {
        const componentName = node.id.name;
        componentMap[componentName] = {
          Component: node.id
        };
        // new style React.Component accepts 'props' as the first parameter
        if (node.superTypeParameters && node.superTypeParameters.params[0]) {
          componentMap[componentName].propType =
            node.superTypeParameters.params[0];
        }
      },
      FunctionDeclaration(node) {
        const componentName = node.id.name;
        componentMap[componentName] = {
          Component: node.id
        };
        if (node.params.length > 0 && node.params[0].typeAnnotation) {
          const propType = node.params[0].typeAnnotation.typeAnnotation;
          if (propType) {
            componentMap[componentName].propType = propType;
          }
        }
      },
      TaggedTemplateExpression(node) {
        const ast = getGraphQLAST(node);
        if (!ast) {
          return;
        }
        ast.definitions.forEach(def => {
          if (!def.name) {
            // no name, covered by graphql-naming/TaggedTemplateExpression
            return;
          }
          if (def.kind === 'FragmentDefinition') {
            expectedTypes.push(def.name.value);
          }
        });
      },
      'Program:exit': function (_node) {
        useFragmentInstances.forEach(useFragmentInstance => {
          const fragmentName = useFragmentInstance.fragmentName;
          const hookName = useFragmentInstance.hookName;
          const node = useFragmentInstance.node;
          const foundImport = imports.some(importDeclaration => {
            const importedFromModuleName = importDeclaration.source.value;
            // `includes()` to allow a suffix like `.js` or path prefixes
            if (!importedFromModuleName.includes(fragmentName + '.graphql')) {
              return false;
            }
            // import type {...} from '...';
            if (importDeclaration.importKind === 'type') {
              return importDeclaration.specifiers.some(
                specifier =>
                  specifier.type === 'ImportSpecifier' &&
                  specifier.imported.name === fragmentName + '$key'
              );
            }
            // import {type xyz} from '...';
            if (importDeclaration.importKind === 'value') {
              return importDeclaration.specifiers.some(
                specifier =>
                  specifier.type === 'ImportSpecifier' &&
                  specifier.importKind === 'type' &&
                  specifier.imported.name === fragmentName + '$key'
              );
            }
            return false;
          });

          if (foundImport) {
            return;
          }

          // Check if the fragment ref that we're passing to the hook
          // comes from a previous useFragment (or variants) hook call.
          const fragmentRefArgName =
            node.arguments[1] != null ? node.arguments[1].name : null;
          const foundFragmentRefDeclaration = useFragmentInstances.some(
            _useFragmentInstance => {
              if (_useFragmentInstance === useFragmentInstance) {
                return false;
              }
              const variableDeclaratorNode = _useFragmentInstance.node.parent;
              if (
                !variableDeclaratorNode ||
                !variableDeclaratorNode.id ||
                !variableDeclaratorNode.id.type
              ) {
                return false;
              }
              if (variableDeclaratorNode.id.type === 'Identifier') {
                return (
                  fragmentRefArgName != null &&
                  variableDeclaratorNode.id.name === fragmentRefArgName
                );
              }
              if (
                variableDeclaratorNode.id.type === 'ObjectPattern' &&
                variableDeclaratorNode.id.properties != null
              ) {
                return variableDeclaratorNode.id.properties.some(prop => {
                  return (
                    fragmentRefArgName != null &&
                    prop &&
                    prop.value &&
                    prop.value.name === fragmentRefArgName
                  );
                });
              }
              return false;
            }
          );

          if (foundFragmentRefDeclaration) {
            return;
          }

          context.report({
            node: node,
            message:
              'The prop passed to {{hookName}}() should be typed with the ' +
              "type '{{name}}$key' imported from '{{name}}.graphql', " +
              'e.g.:\n' +
              '\n' +
              "  import type {{{name}}$key} from '{{name}}.graphql';",
            data: {
              name: fragmentName,
              hookName: hookName
            }
          });
        });
        expectedTypes.forEach(type => {
          const componentName = type.split('_')[0];
          const propName = type.split('_').slice(1).join('_');
          if (!componentName || !propName || !componentMap[componentName]) {
            // incorrect name, covered by graphql-naming/CallExpression
            return;
          }

          const {Component, propType} = componentMap[componentName];

          // resolve local type alias
          const importedPropType = imports.reduce((acc, node) => {
            if (node.specifiers) {
              const typeSpecifier = node.specifiers.find(specifier => {
                if (specifier.type !== 'ImportSpecifier') {
                  return false;
                }
                return specifier.imported.name === type;
              });
              if (typeSpecifier) {
                return typeSpecifier.local.name;
              }
            }
            return acc;
          }, type);

          const importFixRange = genImportFixRange(type, imports, requires);

          if (propType) {
            // There exists a prop typeAnnotation. Let's look at how it's
            // structured
            switch (propType.type) {
              case 'ObjectTypeAnnotation': {
                validateObjectTypeAnnotation(
                  context,
                  options,
                  Component,
                  importedPropType,
                  propName,
                  propType,
                  importFixRange,
                  typeAliasMap
                );
                break;
              }
              case 'GenericTypeAnnotation': {
                const aliasedObjectType = extractReadOnlyType(
                  resolveTypeAlias(propType, typeAliasMap)
                );
                if (!aliasedObjectType) {
                  // The type Alias doesn't exist, is invalid, or is being
                  // imported. Can't do anything.
                  break;
                }
                switch (aliasedObjectType.type) {
                  case 'ObjectTypeAnnotation': {
                    validateObjectTypeAnnotation(
                      context,
                      options,
                      Component,
                      importedPropType,
                      propName,
                      aliasedObjectType,
                      importFixRange,
                      typeAliasMap
                    );
                    break;
                  }
                  case 'IntersectionTypeAnnotation': {
                    const objectTypes = aliasedObjectType.types
                      .map(intersectedType => {
                        if (intersectedType.type === 'GenericTypeAnnotation') {
                          return extractReadOnlyType(
                            resolveTypeAlias(intersectedType, typeAliasMap)
                          );
                        }
                        if (intersectedType.type === 'ObjectTypeAnnotation') {
                          return intersectedType;
                        }
                      })
                      .filter(maybeObjectType => {
                        // GenericTypeAnnotation may not map to an object type
                        return (
                          maybeObjectType &&
                          maybeObjectType.type === 'ObjectTypeAnnotation'
                        );
                      });
                    if (!objectTypes.length) {
                      // The type Alias is likely being imported.
                      // Can't do anything.
                      break;
                    }
                    for (const objectType of objectTypes) {
                      const isValid = validateObjectTypeAnnotation(
                        context,
                        options,
                        Component,
                        importedPropType,
                        propName,
                        objectType,
                        importFixRange,
                        typeAliasMap,
                        true // Return false if invalid instead of reporting
                      );
                      if (isValid) {
                        break;
                      }
                    }
                    // otherwise report an error at the first object
                    validateObjectTypeAnnotation(
                      context,
                      options,
                      Component,
                      importedPropType,
                      propName,
                      objectTypes[0],
                      importFixRange,
                      typeAliasMap
                    );
                    break;
                  }
                }
                break;
              }
            }
          } else {
            context.report({
              message:
                'Component property `{{prop}}` expects to use the ' +
                'generated `{{type}}` flow type. See https://facebook.github.io/relay/docs/en/graphql-in-relay.html#importing-generated-definitions',
              data: {
                prop: propName,
                type: importedPropType
              },
              fix: options.fix
                ? fixer => {
                    const declaration =
                      Component.parent.type === 'VariableDeclarator'
                        ? Component.parent.parent
                        : Component.parent;

                    const aliasWhitespace = ' '.repeat(
                      declaration.loc.start.column
                    );

                    let propsFix;

                    if (Component.parent.type === 'ClassDeclaration') {
                      propsFix = fixer.insertTextAfter(
                        Component.parent.superClass,
                        '<Props>'
                      );
                    } else if (Component.parent.type === 'VariableDeclarator') {
                      propsFix = Component.parent.init.params[0]
                        ? fixer.insertTextAfter(
                            Component.parent.init.params[0],
                            ': Props'
                          )
                        : fixer.insertTextAfterRange(
                            [0, Component.parent.init.range[0] + 1],
                            'props: Props'
                          );
                    } else {
                      // FunctionDeclarator
                      propsFix = Component.parent.params[0]
                        ? fixer.insertTextAfter(
                            Component.parent.params[0],
                            ': Props'
                          )
                        : fixer.insertTextAfterRange(
                            [0, Component.parent.id.range[1] + 1],
                            'props: Props'
                          );
                    }

                    return [
                      genImportFixer(
                        fixer,
                        importFixRange,
                        importedPropType,
                        options,
                        context.getFilename(),
                        aliasWhitespace
                      ),
                      fixer.insertTextBefore(
                        declaration,
                        `type Props = {${propName}: ` +
                          `${importedPropType}};\n\n${aliasWhitespace}`
                      ),
                      propsFix
                    ];
                  }
                : null,
              loc: Component.loc
            });
          }
        });
      }
    };
  }
};
