# Dependencies

Machine prerequisites, and the `jobship doctor` check that verifies each. Setup steps are in the [install guide](../guide/install.md). Terms follow [GLOSSARY.md](../../GLOSSARY.md).

| Prerequisite                   | Needed for                                             | Required                | `jobship doctor` check                                  |
| ------------------------------ | ------------------------------------------------------ | ----------------------- | ------------------------------------------------------- |
| bun 1.4.4                      | Running from source and contributing                   | Only from source        | none                                                    |
| gh                             | Contributing and `repo-settings:check`                 | Contributors only       | none                                                    |
| curl, sha256sum or shasum, tar | Downloading and verifying the release binary and Typst | Yes                     | none                                                    |
| Claude Code plugin             | The skills and the Guard hook                          | Yes                     | `guard.pluginInstalled`, warning `guard-plugin-missing` |
| typst                          | `cv build`                                             | For CVs                 | `tools` status (installed by `jobship setup`)           |
| pdftotext (poppler)            | `cv build` text extraction                             | For CVs                 | `tools` status (error `cv-tool-missing`)                |
| Chrome with remote debugging   | The `apply` and `browser-source` skills over CDP       | For those skills        | none                                                    |
| Browser MCP (chrome-devtools)  | Driving Chrome from Claude Code                        | Optional                | none                                                    |
| Gmail MCP                      | The `inbox` and `outreach` skills                      | Optional                | none                                                    |
| `LINEAR_API_KEY`               | The Linear tracker                                     | Only when kind `linear` | Linear connection check, error `linear-not-ready`       |

`jobship doctor` also self-tests the Guard (`guard.selfTest`) and validates your data files. See the [CLI reference](cli.md#jobship-doctor).
