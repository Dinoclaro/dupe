class Dupe < Formula
  desc "Local-first academic research workspace, BibTeX manager, and MCP server"
  homepage "https://github.com/Dinoclaro/dupe"
  version "0.4.5"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.5/dupe-darwin-arm64.tar.gz"
      sha256 "97ee76fe716a858a3176dad1fc940c0a3dd06afc9632085cbf50854b2fa06b05"
    end
    on_intel do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.5/dupe-darwin-amd64.tar.gz"
      sha256 "cce6c3ecefdbe41c47542a5f2e5468b721e3428e70eae7d2593f04bf218925a6"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.5/dupe-linux-arm64.tar.gz"
      sha256 "07dda1cd8e3b486a6fc67a643b48b408c2e6096e7b657277b670be80f8a94f51"
    end
    on_intel do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.5/dupe-linux-amd64.tar.gz"
      sha256 "bd7753d3ca142e532f0f5dc979d42735b7dcbaf26c52414edce70d0dbcd1a1c8"
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
