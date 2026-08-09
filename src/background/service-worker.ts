const VIEWER_PATH = 'src/viewer/index.html'

chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL(VIEWER_PATH) })

})