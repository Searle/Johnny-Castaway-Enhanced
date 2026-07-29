.PHONY: run window browser

run:
	go run .

# Run in a normal decorated, resizable window (scene letterboxed to 4:3).
# Override the size with SIZE=WxH, e.g. `make window SIZE=1600x1200`.
SIZE ?= 1280x960
window:
	go run . -window $(SIZE)

ttm:
	go run . "ttm"

build-nocache:
	go build -a

runsm:
	./JohnnyCastaway2026 display 0:1728x1117

runbg:
	./JohnnyCastaway2026 display 1:1920x1080

runboth:
	./JohnnyCastaway2026 display 0:1728x1117 &
	./JohnnyCastaway2026 display 1:1920x1080

browser:
	go run main.go resource.go util.go uncompress.go browser.go browser