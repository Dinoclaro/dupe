class Dupe < Formula
  desc "Local-first academic research workspace, BibTeX manager, and MCP server"
  homepage "https://github.com/Dinoclaro/dupe"
  version "0.4.3"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.3/dupe-darwin-arm64.tar.gz"
      sha256 "f56cde4bdde7a9a40eaa1f4a8b61465ca09c4063be4b00d0ca0873d3fa824a7f"
    end
    on_intel do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.3/dupe-darwin-amd64.tar.gz"
      sha256 "52d8334c6c43682900b8b21384d1ecf40c817cd59abf509c9c5ef8dd684b9e37"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.3/dupe-linux-arm64.tar.gz"
      sha256 "2a9faac00b7d8b96b1118dc5e6c6273debd923ce3eef6ab64e6a9ca9151cb1d3"
    end
    on_intel do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.3/dupe-linux-amd64.tar.gz"
      sha256 "1526364395ac40c4ee87afce11bab10582c7b1825e807a94944696dd343d5576"
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
