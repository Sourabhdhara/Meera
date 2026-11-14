param(
    [string]$Title = "MEERA",
    [string]$Message = "Hello from MEERA!",
    [int]$DurationSec = 6
)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

try {
    [System.Media.SystemSounds]::Asterisk.Play()
} catch {}

$displayTitle = $Title.Trim()
if (-not ($displayTitle -match '^[\p{So}\p{Sk}\p{Cs}\p{Cn}\p{Co}\u2700-\u27BF\uE000-\uF8FF]')) {
    $displayTitle = "✨ $displayTitle"
}

$cleanTitle = [System.Security.SecurityElement]::Escape($displayTitle)
$cleanMessage = [System.Security.SecurityElement]::Escape($Message.Trim())

$xamlString = @"
<Window
    xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
    Title="MEERA Notification"
    WindowStyle="None"
    AllowsTransparency="True"
    Background="Transparent"
    Topmost="True"
    ShowInTaskbar="False"
    SizeToContent="WidthAndHeight"
    ResizeMode="NoResize">
    <Border Background="#181825"
            BorderBrush="#89b4fa"
            BorderThickness="2"
            CornerRadius="14"
            Padding="18,14,18,14"
            MaxWidth="440"
            MinWidth="340">
        <Border.Effect>
            <DropShadowEffect Color="#000000" BlurRadius="24" ShadowDepth="4" Opacity="0.6"/>
        </Border.Effect>
        <StackPanel Orientation="Vertical">
            <DockPanel LastChildFill="False" Margin="0,0,0,8">
                <TextBlock DockPanel.Dock="Left"
                           Text="$cleanTitle"
                           FontFamily="Segoe UI"
                           FontSize="14"
                           FontWeight="Bold"
                           Foreground="#cba6f7"/>
                <TextBlock x:Name="BtnClose"
                           DockPanel.Dock="Right"
                           Text="✕"
                           FontFamily="Segoe UI"
                           FontSize="12"
                           FontWeight="Bold"
                           Foreground="#6c7086"
                           Cursor="Hand"
                           Padding="12,0,0,0"/>
            </DockPanel>
            <TextBlock Text="$cleanMessage"
                       FontFamily="Segoe UI"
                       FontSize="13"
                       Foreground="#cdd6f4"
                       TextWrapping="Wrap"
                       LineHeight="18"/>
        </StackPanel>
    </Border>
</Window>
"@

try {
    $stringReader = New-Object System.IO.StringReader($xamlString)
    $xmlReader = [System.Xml.XmlReader]::Create($stringReader)
    $window = [System.Windows.Markup.XamlReader]::Load($xmlReader)

    $btnClose = $window.FindName("BtnClose")
    $btnClose.Add_MouseDown({
        $window.Close()
    })
    $btnClose.Add_MouseEnter({
        $btnClose.Foreground = [System.Windows.Media.Brushes]::IndianRed
    })
    $btnClose.Add_MouseLeave({
        $btnClose.Foreground = (New-Object System.Windows.Media.BrushConverter).ConvertFromString("#6c7086")
    })

    $workArea = [System.Windows.SystemParameters]::WorkArea
    $window.Add_Loaded({
        $window.Left = $workArea.Right - $window.ActualWidth - 24
        $window.Top = $workArea.Bottom - $window.ActualHeight - 24
    })

    $timer = New-Object System.Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromSeconds($DurationSec)
    $timer.Add_Tick({
        $timer.Stop()
        $window.Close()
    })
    $timer.Start()

    $window.ShowDialog() | Out-Null
} catch {}
