# frozen_string_literal: true

# qqq: the QQQ command-line client and terminal UI (qqq ui) in one binary.
# Kept in qqq-cli at docs/packaging/homebrew-tap/Formula/qqq.rb; scripts/update-packaging.mjs fills
# version and sha256 from the SHA256SUMS of a GitHub release, then the file is copied to the tap.
class Qqq < Formula
  desc "Command-line client and terminal UI for QQQ applications"
  homepage "https://github.com/QRun-IO/qqq-cli"
  version "1.0.0"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/QRun-IO/qqq-cli/releases/download/cli-v#{version}/qqq-darwin-arm64"
      sha256 "5017a32ac5031d9146d541381099a959e5c19bbf04c48f725045d89d6007b211"
    end
    on_intel do
      url "https://github.com/QRun-IO/qqq-cli/releases/download/cli-v#{version}/qqq-darwin-x64"
      sha256 "eb9b1d43d24b639118d94b175c343080a39ae9ba64c24645c1792ff3b16a37f1"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/QRun-IO/qqq-cli/releases/download/cli-v#{version}/qqq-linux-arm64"
      sha256 "25f513bdda13bbe40cf536844eebc1e3a7e21cf7804024f25ebe7c42793d7ebc"
    end
    on_intel do
      url "https://github.com/QRun-IO/qqq-cli/releases/download/cli-v#{version}/qqq-linux-x64"
      sha256 "804d06cb7c0012c2f185ae5d94c6bb8f9e2482a440bb3c165361f1a14c941e41"
    end
  end

  def install
    binary = Dir["qqq-*"].first
    chmod 0755, binary # downloads arrive without the execute bit; completions below run the binary
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

  def caveats
    <<~EOS
      qqq ui opens the terminal UI (bundled in this binary). Sign in first:
        qqq login --server https://your-qqq-server
    EOS
  end

  test do
    # the release binaries carry the terminal UI; a CLI-only build here would be a packaging mistake
    assert_match(/qqq #{Regexp.escape(version.to_s)} \(.* binary with ui/, shell_output("#{bin}/qqq --version"))
    assert_match "table", shell_output("#{bin}/qqq __complete -- ta")
  end
end
