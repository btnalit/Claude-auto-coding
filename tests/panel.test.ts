import { describe, expect, test } from 'claude-code/testing'

import { railOf } from '../hooks/panel'
import { checkCommand } from '../hooks/policy'

const PROTECTED = ['main', 'master', 'release/*']

/** A denial as the boundary records it: the tool, the command, and the reason the policy gave. */
function denial(command: string, branch = 'feat/login'): string {
  return `Bash: ${command} — ${checkCommand(command, { branch, protectedBranches: PROTECTED }) ?? ''}`
}

describe('the rail lights the trigger the reason names, not a word in the command', () => {
  const cases: Array<[string, string | undefined, ReturnType<typeof railOf>]> = [
    ['git merge release-notes', 'main', '合并'],
    ['git push origin release/1.2', undefined, '合并'],
    ['gh pr merge 3', undefined, '合并'],
    ["gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"PR_1\"}) { clientMutationId } }'", undefined, '合并'],
    ["gh api graphql -f query='mutation { createRelease(input: {repositoryId: \"R_1\", tagName: \"v1\"}) { clientMutationId } }'", undefined, '发版'],
    ['gh api repos/o/r/releases -f tag_name=v1', undefined, '发版'],
    ['gh api -X POST repos/o/r/git/tags -f tag=v1', undefined, 'tag'],
    ['gh release create v1.4.0', undefined, '发版'],
    ['git tag v1.4.0', undefined, 'tag'],
    ['git push origin tag release-final', undefined, 'tag'],
    ['git push --tags', undefined, 'tag'],
    ['npm publish', undefined, '发布'],
  ]
  for (const [command, branch, rail] of cases) {
    test(`${command.slice(0, 50)} lights ${rail}`, () => {
      expect(railOf(denial(command, branch))).toBe(rail)
    })
  }
})
