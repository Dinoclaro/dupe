class Dupe < Formula
  desc "Local-first academic research workspace, BibTeX manager, and MCP server"
  homepage "https://github.com/Dinoclaro/dupe"
  version "0.4.4"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.4/dupe-darwin-arm64.tar.gz"
      sha256 "453b190e36a7aa2d0f8e70295fd67910ef4adac71161385de76c08b564b182c8"
    end
    on_intel do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.4/dupe-darwin-amd64.tar.gz"
      sha256 "60b5c96cb825f47000375a781ae6c242333e65320dcbfcff745bbd5e217a15d3"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.4/dupe-linux-arm64.tar.gz"
      sha256 "8eb293fbd2a4ce5e350c7f4960c84fc17182fd10beea9fe06e36e35843bac2f2"
    end
    on_intel do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.4/dupe-linux-amd64.tar.gz"
      sha256 "6375fb47c7d895ae4587dba53b7216974f4a2b31733ead38d6d3d7352df51ca1"
    end
  end

  def install
    libexec.install Dir["*"]
    chmod 0755, libexec/"backend/server"
    bin.install_symlink libexec/"backend/server" => "dupe"
  end

  def post_install
    (var/"dupe").mkpath
  end

  service do
    run [opt_bin/"dupe", "serve", "--mode", "local"]
    keep_alive true
    working_dir var/"dupe"
    log_path var/"log/dupe.log"
    error_log_path var/"log/dupe.log"
  end

  def caveats
    <<~EOS
      To run dupe automatically on login via Homebrew:
        brew services start dupe

      To initialize a project folder:
        cd ~/my-paper && dupe init

      To install/update the dupe-studio VS Code extension and herdr agents:
        dupe update --force --no-restart
    EOS
  end

  test do
    assert_match "dupe ", shell_output("#{bin}/dupe --version")
  end
end
