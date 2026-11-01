# Draft Homebrew formula for the qqq CLI, in the style of QRun-IO/homebrew-qctl's qctl.rb.
# scripts/update-packaging.mjs fills version and sha256 from dist/SHA256SUMS of a release build;
# copy the result to Formula/qqq.rb in the tap (see docs/packaging/README.md).
class Qqq < Formula
  desc "Command-line client for QQQ applications, built on the QQQ UI API"
  homepage "https://github.com/QRun-IO/qqq-cli"
  version "1.0.0-rc.1"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/QRun-IO/qqq-cli/releases/download/cli-v#{version}/qqq-darwin-arm64"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
    on_intel do
      url "https://github.com/QRun-IO/qqq-cli/releases/download/cli-v#{version}/qqq-darwin-x64"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/QRun-IO/qqq-cli/releases/download/cli-v#{version}/qqq-linux-arm64"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
    on_intel do
      url "https://github.com/QRun-IO/qqq-cli/releases/download/cli-v#{version}/qqq-linux-x64"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  def install
    binary = Dir["qqq-*"].first
    bin.install binary => "qqq"
    generate_completions_from_executable(bin/"qqq", "completion", shells: [:bash, :fish])
    # `qqq completion zsh` is an eval script; an fpath file needs the #compdef form
    (zsh_completion/"_qqq").write <<~ZSH
      #compdef qqq
      local -a candidates
      candidates=("${(@f)$(qqq __complete -- "${words[@]:1:$CURRENT-1}" 2>/dev/null)}")
      compadd -- "${candidates[@]}"
    ZSH
  end

  test do
    assert_match "qqq #{version}", shell_output("#{bin}/qqq --version")
    assert_match "table", shell_output("#{bin}/qqq __complete -- ta")
  end
end
