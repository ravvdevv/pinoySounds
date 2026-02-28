// Error Sounds VSCode Extension
// Plays sounds when errors/warnings are detected in editor diagnostics or terminal

const vscode = require('vscode');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');

let statusBarItem;
let lastErrorCount = 0;
let lastSoundTime = 0;
let diagnosticListener = null;

const outputChannel = vscode.window.createOutputChannel("pinoySounds");

function log(msg) {
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// Sound arrays
let errorSounds = [];
let terminalSounds = [];

/**
 * Play an MP3 file using platform-native tools
 */
function playMp3(filePath) {
  const platform = os.platform();
  log(`Attempting to play: ${filePath} on ${platform}`);

  try {
    if (platform === 'win32') {
      // Use MediaPlayer from PresentationCore — robust for MP3
      // We use a URI to avoid path issues
      const uriPath = filePath.replace(/\\/g, '/');
      const psCommand = `Add-Type -AssemblyName PresentationCore; $p = New-Object system.windows.media.mediaplayer; $p.Open([uri]'file:///${uriPath}'); $p.Play(); Start-Sleep -s 5`;

      log(`Running PS command: ${psCommand}`);

      exec(`powershell -ExecutionPolicy Bypass -Command "${psCommand}"`, (error, stdout, stderr) => {
        if (error) {
          log(`Error playing sound: ${error.message}`);
          return;
        }
        if (stderr) {
          log(`PS Stderr: ${stderr}`);
        }
      });
    } else if (platform === 'darwin') {
      exec(`afplay "${filePath}"`, { timeout: 5000 });
    } else {
      // Linux: prefer mpg123 / ffplay / cvlc
      const players = ['mpg123', 'ffplay -nodisp -autoexit', 'cvlc --play-and-exit'];
      let played = false;
      for (const player of players) {
        try {
          const bin = player.split(' ')[0];
          require('child_process').execSync(`which ${bin}`, { stdio: 'ignore' });
          exec(`${player} "${filePath}"`, { timeout: 5000 });
          played = true;
          break;
        } catch { }
      }
      if (!played) {
        // Last resort: system bell
        process.stdout.write('\x07');
      }
    }
  } catch (e) {
    // Silently fail — audio not critical
  }
}

function initSounds(context) {
  try {
    const extRoot = context.extensionUri.fsPath;

    // Randomize between soundeffect and ulol for errors
    errorSounds = [
      path.join(extRoot, 'sounds/soundeffect.mp3'),
      path.join(extRoot, 'sounds/ulol.mp3')
    ];

    terminalSounds = errorSounds; // Also use error sounds for terminal

    log(`Initialised sounds:`);
    log(` - extRoot: ${extRoot}`);
    log(` - Error pool: ${errorSounds.join(', ')}`);
  } catch (e) {
    log(`Error in initSounds: ${e.message}`);
  }
}

function canPlaySound() {
  const config = vscode.workspace.getConfiguration('pinoySounds');
  if (!config.get('enabled')) return false;
  const debounce = config.get('debounceMs') || 1000;
  const now = Date.now();
  if (now - lastSoundTime < debounce) return false;
  lastSoundTime = now;
  return true;
}

function playSound(type) {
  if (!canPlaySound()) return;

  let soundPool = [];
  if (type === 'error' || type === 'terminal') {
    soundPool = errorSounds;
  } else {
    return;
  }

  if (soundPool.length > 0) {
    const randomIndex = Math.floor(Math.random() * soundPool.length);
    const fp = soundPool[randomIndex];
    playMp3(fp);
    updateStatusBar(type);
  } else {
    log(`No sounds available for type: ${type}`);
  }
}

function updateStatusBar(type) {
  const icons = { error: '🔴', warning: '🟡', terminal: '💥' };
  const labels = { error: 'Error!', warning: 'Warning!', terminal: 'nag ERROR HAHAHAHA' };
  statusBarItem.text = `$(unmute) ${icons[type] || '🔊'} ${labels[type] || type}`;
  statusBarItem.show();
  setTimeout(() => {
    statusBarItem.text = '$(unmute) pinoySounds';
    statusBarItem.show();
  }, 3000);
}

function activate(context) {
  log('pinoySounds extension activating...');

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(unmute) pinoySounds';
  statusBarItem.tooltip = 'pinoySounds: Active — click to test';
  statusBarItem.command = 'pinoySounds.test';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Init sound paths
  initSounds(context);

  // Re-init when config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('pinoySounds')) {
        initSounds(context);
      }
    })
  );

  // Watch diagnostics (errors/warnings in editor)
  diagnosticListener = vscode.languages.onDidChangeDiagnostics(e => {
    const config = vscode.workspace.getConfiguration('pinoySounds');
    if (!config.get('enabled')) return;

    let totalErrors = 0;
    let totalWarnings = 0;

    for (const [, diagnostics] of vscode.languages.getDiagnostics()) {
      for (const d of diagnostics) {
        if (d.severity === vscode.DiagnosticSeverity.Error) totalErrors++;
        else if (d.severity === vscode.DiagnosticSeverity.Warning) totalWarnings++;
      }
    }

    const prevErrors = lastErrorCount;
    lastErrorCount = totalErrors;

    if (config.get('playOnError') && totalErrors > prevErrors) {
      playSound('error');
    }
  });
  context.subscriptions.push(diagnosticListener);

  // Watch terminal for error exit codes (shell integration)
  context.subscriptions.push(
    vscode.window.onDidEndTerminalShellExecution(event => {
      const config = vscode.workspace.getConfiguration('pinoySounds');
      if (!config.get('enabled')) return;

      const exitCode = event.exitCode;
      if (exitCode !== undefined) {
        if (exitCode !== 0 && config.get('playOnTerminalError')) {
          playSound('terminal');
          vscode.window.setStatusBarMessage(`$(error) Terminal exited with code ${exitCode}`, 5000);
        }
      }
    })
  );

  // --- NEW: Task Listener (Runtime Errors / Tasks) ---
  context.subscriptions.push(
    vscode.tasks.onDidEndTaskProcess((e) => {
      const config = vscode.workspace.getConfiguration('pinoySounds');
      if (!config.get('enabled')) return;

      if (e.exitCode !== undefined && e.exitCode !== 0) {
        log(`Task ${e.execution.task.name} failed with exit code ${e.exitCode}`);
        playSound('terminal'); // Use randomized error sound
      }
    })
  );

  // --- NEW: Debug Listener (Crashes / End of Session) ---
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession((session) => {
      const config = vscode.workspace.getConfiguration('pinoySounds');
      if (!config.get('enabled')) return;

      // Optional: Add logic here to detect if the session ended due to an error
      // For now, we just log it as a hook possibility
      log(`Debug session terminated: ${session.name}`);
    })
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('pinoySounds.test', () => {
      lastSoundTime = 0;
      playSound('error');
      vscode.window.showInformationMessage('🔊 pinoySounds: Playing error sound!');
    })
  );
}

function deactivate() {
  if (statusBarItem) statusBarItem.dispose();
}

module.exports = { activate, deactivate };
