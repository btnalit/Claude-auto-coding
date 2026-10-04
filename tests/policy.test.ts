import { describe, expect, test } from 'claude-code/testing'

import { checkCommand } from '../hooks/policy'

const PROTECTED = ['main', 'master', 'release/*']
const onFeature = { branch: 'feat/login', protectedBranches: PROTECTED }
const onMain = { branch: 'main', protectedBranches: PROTECTED }

describe('allowed: push, PR and ordinary work', () => {
  const allowed: Array<[string, typeof onFeature]> = [
    ['git push -u origin HEAD', onFeature],
    ['git push origin feat/login', onFeature],
    ['git push --force-with-lease origin feat/login', onFeature],
    ['git -C D:/repo push origin HEAD:feat/login', onFeature],
    ['gh pr create --title "Add login" --body "merge after review; npm publish later"', onFeature],
    ['gh pr view 12 && gh pr checks 12', onFeature],
    ['git merge main', onFeature],
    ['git rebase main', onFeature],
    ['git pull origin main', onMain],
    ['git commit -am "fix: guard; git merge main and npm publish"', onMain],
    ["git commit -m \"$(cat <<'EOF'\nrelease: npm publish flow\ngit merge main\nEOF\n)\"", onMain],
    ['git tag', onFeature],
    ['git tag -l "v*"', onFeature],
    ['git branch -d feat/old', onFeature],
    ['npm test; npm run build', onFeature],
    ['npm version', onFeature],
    ['npm version --json', onFeature],
    ['docker build -t app .', onFeature],
    ['gh api repos/o/r/pulls/3/merge', onFeature],
    ['git merge --abort', onMain],
    ["gh api graphql -f query='query { repository(owner: \"o\", name: \"r\") { pullRequest(number: 3) { mergeable } } }'", onFeature],
    ['gh -R o/r pr view 3', onFeature],
    ["git commit -F - <<'EOF'\nchore: notes\ngit push origin main\nEOF", onMain],
    ["git commit -m @'\nrelease: git merge main\n'@", onMain],
    ["@'\ngit push origin main\n'@ | Set-Content notes.md", onFeature],
    ["gh api graphql -F query=@- <<'EOF'\nquery { repository(owner: \"o\", name: \"r\") { pullRequest(number: 3) { mergeable } } }\nEOF", onFeature],
  ]
  for (const [command, context] of allowed) {
    test(`allows: ${command.split('\n')[0]}`, () => {
      expect(checkCommand(command, context)).toBeUndefined()
    })
  }
})

describe('denied: merge into a protected branch, tags and releases', () => {
  const denied: Array<[string, typeof onFeature]> = [
    ['gh pr merge 12 --squash', onFeature],
    ['gh pr merge --auto 12', onFeature],
    ['git merge feat/login', onMain],
    ['git checkout main && git merge feat/login', onFeature],
    ['git switch master; git merge -', onFeature],
    ['git rebase feat/login', onMain],
    ['git push origin main', onFeature],
    ['git push origin HEAD:main', onFeature],
    ['git push origin +feat/login:refs/heads/main', onFeature],
    ['git push', onMain],
    ['git push -u origin HEAD', onMain],
    ['git push origin :main', onFeature],
    ['git push origin release/1.2', onFeature],
    ['git push --tags', onFeature],
    ['git push --follow-tags origin feat/login', onFeature],
    ['git push origin v1.4.0', onFeature],
    ['git push origin refs/tags/v1', onFeature],
    ['git tag v1.4.0', onFeature],
    ['git tag -a v1.4.0 -m "release"', onFeature],
    ['git branch -f main HEAD', onFeature],
    ['git update-ref refs/heads/main HEAD', onFeature],
    ['gh release create v1.4.0 --generate-notes', onFeature],
    ['gh api -X PUT repos/o/r/pulls/3/merge', onFeature],
    ['gh api repos/o/r/releases -f tag_name=v1', onFeature],
    ['npm publish --access public', onFeature],
    ['pnpm publish', onFeature],
    ['yarn npm publish', onFeature],
    ['npm version patch', onFeature],
    ['yarn version --patch', onFeature],
    ['yarn version --new-version=2.0.0', onFeature],
    ['cargo publish', onFeature],
    ['npx semantic-release', onFeature],
    ['docker push registry/app:1.0', onFeature],
    ["sh -c 'git push origin main'", onFeature],
    ['cd sub && npm publish', onFeature],
    ['C:\\Program Files\\Git\\cmd\\git.exe push origin main', onFeature],
    ['& git.exe push origin main', onFeature],
    ["bash <<'EOF'\ngit push --tags\nEOF", onFeature],
    ["gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"PR_1\"}) { clientMutationId } }'", onFeature],
    ["gh api graphql -f query='mutation { mergeBranch(input: {repositoryId: \"R_1\", base: \"main\", head: \"feat\"}) { clientMutationId } }'", onFeature],
    ['gh -R o/r pr merge 3 --squash', onFeature],
    ['gh --repo o/r release create v1.4.0', onFeature],
    ['git push origin tag rc-final', onFeature],
    ["bash -s <<'EOF'\ngit push origin main\nEOF", onFeature],
    ["cat <<'EOF' | bash\ngit push --tags\nEOF", onFeature],
    ["@'\ngit push origin main\n'@ | Invoke-Expression", onFeature],
    ['Invoke-Expression @"\ngit push --tags\n"@', onFeature],
    ["@'\ngit tag v1.4.0\n'@ | iex", onFeature],
    ["gh api graphql -F query=@- <<'EOF'\nmutation { mergePullRequest(input: {pullRequestId: \"PR_1\"}) { clientMutationId } }\nEOF", onFeature],
  ]
  for (const [command, context] of denied) {
    test(`denies: ${command.split('\n')[0]}`, () => {
      expect(checkCommand(command, context)).toBeDefined()
    })
  }
})
