class Dupe < Formula
  desc "Local-first academic research workspace, BibTeX manager, and MCP server"
  homepage "https://github.com/Dinoclaro/dupe"
  version "0.4.6"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.6/dupe-darwin-arm64.tar.gz"
      sha256 "67b1c73daa3d9e8b39a54d9e8a64dd976649fa7188a4d8c61b451dd7b2487c3d"
    end
    on_intel do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.6/dupe-darwin-amd64.tar.gz"
      sha256 "f8832ded94bc17ea93376acf78a8d3b4b40e9dd71cbdd63fa0dc96487034d817"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.6/dupe-linux-arm64.tar.gz"
      sha256 "f9ffd1590dd11d2ca5219a5b4a6ddd9716e830908a1de7a9e384c7b7f43ede25"
    end
    on_intel do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.6/dupe-linux-amd64.tar.gz"
      sha256 "5063d8b99f90df2625bf03fdd172a3d2f0133210bc53909e91260550e05275b6"
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
