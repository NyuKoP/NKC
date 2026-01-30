param(
  [string]$Path = "src/app/App.tsx"
)

if (-not (Test-Path -Path $Path)) {
  Write-Error "File not found: $Path"
  exit 1
}

$content = Get-Content -Raw -Encoding UTF8 -Path $Path
$newline = if ($content -match "`r`n") { "`r`n" } else { "`n" }

function Get-MojibakeVariants {
  param([string]$Text)
  $variants = New-Object System.Collections.Generic.HashSet[string]
  $utf8 = [Text.Encoding]::UTF8
  $cp949 = [Text.Encoding]::GetEncoding(949)
  $null = $variants.Add($Text)
  try { $null = $variants.Add($cp949.GetString($utf8.GetBytes($Text))) } catch {}
  try { $null = $variants.Add($utf8.GetString($cp949.GetBytes($Text))) } catch {}
  return $variants
}

$changed = $false

# Context-specific fixes (ambiguous phrases).
$startVariants = Get-MojibakeVariants "채팅을 시작했어요."
foreach ($v in $startVariants) {
  $pattern = "lastMessage:\s*`"" + [regex]::Escape($v) + "`""
  if ($content -match $pattern) {
    $content = [regex]::Replace($content, $pattern, 'lastMessage: "채팅을 시작했어요."')
    $changed = $true
  }
  $pattern = "text:\s*`"" + [regex]::Escape($v) + "`""
  if ($content -match $pattern) {
    $content = [regex]::Replace($content, $pattern, 'text: "채팅을 시작했어요."')
    $changed = $true
  }
}

$deleteVariants = Get-MojibakeVariants "채팅을 삭제했어요."
foreach ($v in $deleteVariants) {
  $pattern = "message:\s*`"" + [regex]::Escape($v) + "`""
  if ($content -match $pattern) {
    $content = [regex]::Replace($content, $pattern, 'message: "채팅을 삭제했어요."')
    $changed = $true
  }
}

# General replacements for known UI strings and comments.
$targets = @(
  "세션이 만료되었으니 다시 로그인해 주세요.",
  "초기화에 실패했습니다.",
  "세션이 연결되었습니다.",
  "금고 초기화에 실패했습니다.",
  "시작 키 형식이 올바르지 않습니다. (예: NKC-...)",
  "시작 키로 잠금 해제에 실패했습니다.",
  "로그아웃에 실패했습니다.",
  "시작 키가 변경되었습니다. PIN을 다시 설정해 주세요.",
  "시작 키 변경에 실패했습니다.",
  "새 채팅",
  "채팅을 숨겼어요.",
  "채팅을 삭제할까요?",
  "삭제하면 복구할 수 없습니다.",
  "채팅 열기에 실패했습니다.",
  "프로필 열기에 실패했습니다.",
  "친구 변경에 실패했습니다.",
  "즐겨찾기 변경에 실패했습니다.",
  "친구 코드가 복사되었습니다.",
  "친구 코드 복사에 실패했습니다.",
  "메시지 요청 수락에 실패했습니다.",
  "메시지 요청 거절에 실패했습니다.",
  "로그아웃할까요?",
  "세션을 종료하고 로컬 데이터는 유지됩니다.",
  "데이터를 삭제할까요?",
  "로컬 금고가 초기화됩니다.",
  "Direct 연결 허용",
  "Direct 연결은 상대방에게 IP가 노출될 수 있습니다. 허용할까요?",
  "메시지 삭제",
  "이 메시지는 내 기기에서만 삭제됩니다. 삭제 후 복구할 수 없습니다. 계속할까요?",
  "메시지를 삭제했습니다.",
  "메시지 삭제에 실패했습니다.",
  "대화를 선택해주세요.",
  "사진",
  "파일",
  "// cleanup 메모리 문제(EffectCallback) + unsubscribe 방어",
  "// confirm?.onConfirm()가 Promise를 반환해도 UI는 void 처리"
)

foreach ($text in $targets) {
  $variants = Get-MojibakeVariants $text
  foreach ($v in $variants) {
    if ($v -ne $text -and $content.Contains($v)) {
      $content = $content.Replace($v, $text)
      $changed = $true
    }
  }
}

# Fix normalizeInviteCode if it gets corrupted.
$normalizePattern = '(?ms)^\s*const normalizeInviteCode = \(value: string\) =>\s*\r?\n\s*value\.trim\(\)\.replace\(.+?\)\.toUpperCase\(\);'
if ($content -match $normalizePattern) {
  $normalized = [regex]::Replace(
    $content,
    $normalizePattern,
    '  const normalizeInviteCode = (value: string) =>' + $newline + '    value.trim().replace(/\s+/g, "").toUpperCase();'
  )
  if ($normalized -ne $content) {
    $content = $normalized
    $changed = $true
  }
}

if ($changed) {
  $utf8Bom = New-Object System.Text.UTF8Encoding($true)
  [IO.File]::WriteAllText($Path, $content, $utf8Bom)
  Write-Host "Restored i18n strings in $Path"
} else {
  Write-Host "No changes needed in $Path"
}