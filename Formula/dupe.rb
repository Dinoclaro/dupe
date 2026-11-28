class Dupe < Formula
  desc "Local-first academic research workspace, BibTeX manager, and MCP server"
  homepage "https://github.com/Dinoclaro/dupe"
  version "0.4.7"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.7/dupe-darwin-arm64.tar.gz"
      sha256 "8ceb66f5ad1d208d5ad7ef8445df8e1ad49b46c1e43b3f769e42d7e91aa381ff"
    end
    on_intel do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.7/dupe-darwin-amd64.tar.gz"
      sha256 "87a6f3f95babec4ec5b5dcd74e171514f3eff4848899813fb2df6c96d94ed1e0"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.7/dupe-linux-arm64.tar.gz"
      sha256 "c40f8208df024ee786324805351920b981a4e80804b3e23523f8756fa178f0ab"
    end
    on_intel do
      url "https://github.com/Dinoclaro/dupe/releases/download/v0.4.7/dupe-linux-amd64.tar.gz"
      sha256 "c93092a191db87c40b497f87ffc1096de4c9124db6a610221b119b4b145f5821"
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
